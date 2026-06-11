# routes/homies.py
"""Homie Maker API — visual AI agent personas ('homies').

Each homie pairs a PNG avatar + animated mouth overlay with a structured
persona (compiled into its system prompt by src.homie_persona) and its own
independent, concurrent agent session reusing the existing detached
agent-run machinery (src.agent_runs).

Security posture (HOMIE_MAKER_SPEC §5):
  - every route is auth-gated and owner-scoped — no cross-user homie access;
  - avatar uploads are validated by PNG magic bytes + Pillow decode, capped
    via ODYSSEUS_HOMIE_UPLOAD_MAX_BYTES, dimension-capped, and re-encoded
    (which strips all ancillary metadata) into gitignored data/homies/<id>/;
  - homie agent sessions inherit the OWNER's privilege ceiling: the same
    privilege→tool mapping as normal chat, applied before the per-homie
    tool whitelist, so a homie can never exceed what its user may do.
"""

import asyncio
import io
import json
import logging
import os
import shutil
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from core.database import SessionLocal, HomieModel
from core.models import ChatMessage
from src import agent_runs
from src.auth_helpers import get_current_user
from src.constants import DATA_DIR
from src.homie_persona import compile_homie_prompt
from src.upload_limits import (
    HOMIE_UPLOAD_MAX_BYTES,
    format_byte_limit,
    read_upload_limited,
)

logger = logging.getLogger(__name__)

HOMIES_DIR = os.path.join(DATA_DIR, "homies")

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

MOUTH_PRESETS = ("Line smile", "Teeth", "Robot mouth")
VOICE_ENGINES = ("kokoro", "chatterbox")

# Server-side ingest cap: anything larger is downscaled to fit this box.
AVATAR_MAX_DIM = 1024
# Display version edge length.
AVATAR_DISPLAY_DIM = 512

DEFAULT_MOUTH_ANCHOR = {"x": 0.5, "y": 0.7, "scale": 0.35, "rotation": 0}
DEFAULT_VOICE_CONFIG = {"engine": "kokoro", "voice": None, "speed": 1.0, "pitch": 1.0}
DEFAULT_CANVAS_POS = {"x": 100, "y": 100}

# How much per-session history is replayed into each homie agent run.
HOMIE_HISTORY_MAX_MESSAGES = 40


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class HomieCreate(BaseModel):
    name: str
    mouth_preset: Optional[str] = None
    mouth_anchor: Optional[Dict[str, Any]] = None
    mouth_color: Optional[str] = None
    voice_config: Optional[Dict[str, Any]] = None
    persona: Optional[Dict[str, Any]] = None
    tool_whitelist: Optional[List[str]] = None
    pinned: Optional[bool] = None
    canvas_pos: Optional[Dict[str, Any]] = None
    enabled: Optional[bool] = None


class HomieUpdate(BaseModel):
    name: Optional[str] = None
    mouth_preset: Optional[str] = None
    mouth_anchor: Optional[Dict[str, Any]] = None
    mouth_color: Optional[str] = None
    voice_config: Optional[Dict[str, Any]] = None
    persona: Optional[Dict[str, Any]] = None
    tool_whitelist: Optional[List[str]] = None
    pinned: Optional[bool] = None
    canvas_pos: Optional[Dict[str, Any]] = None
    enabled: Optional[bool] = None


class HomieMessage(BaseModel):
    message: str
    stream: bool = False


PERSONA_SUGGEST_FIELDS = {"motivations", "frustrations", "goals"}


class PersonaSuggest(BaseModel):
    field: str
    name: str = ""
    persona: Optional[Dict[str, Any]] = None


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _validate_name(name: str) -> str:
    name = " ".join((name or "").split())
    if not name:
        raise HTTPException(status_code=422, detail="Homie name cannot be empty")
    if len(name) > 80:
        raise HTTPException(status_code=422, detail="Homie name too long (max 80 chars)")
    return name


def _validate_mouth_preset(preset: str) -> str:
    if preset not in MOUTH_PRESETS:
        raise HTTPException(
            status_code=422,
            detail=f"mouth_preset must be one of {list(MOUTH_PRESETS)}",
        )
    return preset


def _validate_mouth_anchor(anchor: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(anchor, dict):
        raise HTTPException(status_code=422, detail="mouth_anchor must be an object")
    out = {}
    for key, lo, hi in (("x", 0.0, 1.0), ("y", 0.0, 1.0), ("scale", 0.01, 2.0), ("rotation", -180.0, 180.0)):
        raw = anchor.get(key, DEFAULT_MOUTH_ANCHOR[key])
        try:
            val = float(raw)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail=f"mouth_anchor.{key} must be a number")
        if not (lo <= val <= hi):
            raise HTTPException(status_code=422, detail=f"mouth_anchor.{key} must be between {lo} and {hi}")
        out[key] = val
    return out


def _validate_mouth_color(color: Optional[str]) -> Optional[str]:
    if color is None or color == "":
        return None
    c = str(color).strip()
    if len(c) == 7 and c[0] == "#" and all(ch in "0123456789abcdefABCDEF" for ch in c[1:]):
        return c
    raise HTTPException(status_code=422, detail="mouth_color must be a #RRGGBB hex string or null")


def _validate_voice_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(cfg, dict):
        raise HTTPException(status_code=422, detail="voice_config must be an object")
    engine = cfg.get("engine", DEFAULT_VOICE_CONFIG["engine"])
    if engine not in VOICE_ENGINES:
        raise HTTPException(
            status_code=422,
            detail=f"voice_config.engine must be one of {list(VOICE_ENGINES)}",
        )
    out = {"engine": engine, "voice": cfg.get("voice")}
    for key in ("speed", "pitch"):
        raw = cfg.get(key, DEFAULT_VOICE_CONFIG[key])
        try:
            val = float(raw)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail=f"voice_config.{key} must be a number")
        if not (0.25 <= val <= 4.0):
            raise HTTPException(status_code=422, detail=f"voice_config.{key} must be between 0.25 and 4.0")
        out[key] = val
    if cfg.get("ref_clip"):
        out["ref_clip"] = str(cfg["ref_clip"])
    return out


def _validate_persona(persona: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(persona, dict):
        raise HTTPException(status_code=422, detail="persona must be an object")
    # The compiler is tolerant by design; here we only ensure JSON-serializable
    # input and clamp slider values so stored data is already normalized.
    try:
        json.dumps(persona)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="persona must be JSON-serializable")
    sliders = persona.get("sliders")
    if sliders is not None:
        if not isinstance(sliders, dict):
            raise HTTPException(status_code=422, detail="persona.sliders must be an object")
        cleaned = {}
        for key, raw in sliders.items():
            try:
                cleaned[key] = max(0, min(100, int(raw)))
            except (TypeError, ValueError):
                raise HTTPException(status_code=422, detail=f"persona.sliders.{key} must be an integer 0-100")
        persona = {**persona, "sliders": cleaned}
    return persona


def _validate_tool_whitelist(wl: Optional[List[str]]) -> Optional[List[str]]:
    if wl is None:
        return None
    if not isinstance(wl, list) or not all(isinstance(t, str) for t in wl):
        raise HTTPException(status_code=422, detail="tool_whitelist must be a list of tool names or null")
    return sorted(set(t.strip() for t in wl if t.strip()))


def _validate_canvas_pos(pos: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(pos, dict):
        raise HTTPException(status_code=422, detail="canvas_pos must be an object")
    out = {}
    for key in ("x", "y"):
        try:
            out[key] = float(pos.get(key, DEFAULT_CANVAS_POS[key]))
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail=f"canvas_pos.{key} must be a number")
    # Optional persisted size (px); clamp to the spec's 64-192 range.
    if "size" in pos:
        try:
            out["size"] = max(64, min(192, int(pos["size"])))
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail="canvas_pos.size must be an integer")
    return out


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------

def _homie_to_dict(h: HomieModel) -> Dict[str, Any]:
    session_id = h.session_id
    status = "working" if (session_id and agent_runs.is_active(session_id)) else "idle"
    return {
        "id": h.id,
        "owner": h.owner,
        "name": h.name,
        "has_avatar": bool(h.avatar_path) and os.path.isfile(h.avatar_path),
        "mouth_preset": h.mouth_preset,
        "mouth_anchor": h.mouth_anchor,
        "mouth_color": h.mouth_color,
        "voice_config": h.voice_config,
        "persona": h.persona,
        "tool_whitelist": h.tool_whitelist,
        "pinned": bool(h.pinned),
        "canvas_pos": h.canvas_pos,
        "enabled": bool(h.enabled),
        "session_id": session_id,
        "status": status,
        "created_at": h.created_at.isoformat() if h.created_at else None,
        "updated_at": h.updated_at.isoformat() if h.updated_at else None,
    }


# ---------------------------------------------------------------------------
# Avatar processing
# ---------------------------------------------------------------------------

def _process_avatar_png(data: bytes) -> Dict[str, bytes]:
    """Validate + normalize an uploaded avatar.

    Returns {"full": png_bytes, "display": png_bytes}. Raises HTTPException
    on anything that is not a decodable real PNG. Re-encoding through Pillow
    drops all ancillary chunks (tEXt/eXIf/etc.) — that IS the metadata strip.
    """
    if not data.startswith(PNG_MAGIC):
        raise HTTPException(status_code=415, detail="Avatar must be a PNG file (magic-byte check failed)")
    try:
        from PIL import Image
    except ImportError:
        raise HTTPException(status_code=500, detail="Image processing unavailable (Pillow not installed)")
    try:
        probe = Image.open(io.BytesIO(data))
        probe.verify()  # structural integrity pass (consumes the parser state)
        img = Image.open(io.BytesIO(data))  # reopen for actual decoding
        img.load()
    except Exception:
        raise HTTPException(status_code=415, detail="Avatar is not a valid PNG image")
    if img.format != "PNG":
        raise HTTPException(status_code=415, detail="Avatar must be a PNG image")

    # Preserve transparency; normalize exotic modes (P with transparency, LA, ...).
    if img.mode not in ("RGBA", "RGB"):
        img = img.convert("RGBA")

    def _encode(im) -> bytes:
        buf = io.BytesIO()
        im.save(buf, format="PNG", optimize=True)  # fresh encode: no source metadata survives
        return buf.getvalue()

    full = img
    if full.width > AVATAR_MAX_DIM or full.height > AVATAR_MAX_DIM:
        full = full.copy()
        full.thumbnail((AVATAR_MAX_DIM, AVATAR_MAX_DIM))  # keeps aspect ratio

    display = full.copy()
    if display.width > AVATAR_DISPLAY_DIM or display.height > AVATAR_DISPLAY_DIM:
        display.thumbnail((AVATAR_DISPLAY_DIM, AVATAR_DISPLAY_DIM))

    return {"full": _encode(full), "display": _encode(display)}


def _avatar_paths(homie_id: str) -> Dict[str, str]:
    base = os.path.join(HOMIES_DIR, homie_id)
    return {
        "dir": base,
        "full": os.path.join(base, "avatar.png"),
        "display": os.path.join(base, "avatar_512.png"),
    }


# ---------------------------------------------------------------------------
# Privilege ceiling — mirrors the chat route's privilege→tool mapping so a
# homie can never use tools its owner can't (HOMIE_MAKER_SPEC §5).
# ---------------------------------------------------------------------------

def _privilege_disabled_tools(request: Request, owner: str) -> set:
    disabled: set = set()
    privs: Dict[str, Any] = {}
    auth_manager = getattr(request.app.state, "auth_manager", None)
    if owner and auth_manager:
        try:
            privs = auth_manager.get_privileges(owner) or {}
        except Exception:
            privs = {}
    if privs:
        if not privs.get("can_use_bash", True):
            disabled.update({"bash", "python", "read_file", "write_file"})
        if not privs.get("can_use_browser", True):
            disabled.add("builtin_browser")
        if not privs.get("can_use_documents", True):
            disabled.update({"create_document", "edit_document", "update_document", "suggest_document"})
        if not privs.get("can_generate_images", True):
            disabled.add("generate_image")
        if not privs.get("can_manage_memory", True):
            disabled.update({"manage_memory", "manage_skills"})
    # Global admin-disabled tools apply to homies exactly like chat.
    try:
        from src.settings import get_setting
        global_disabled = get_setting("disabled_tools", [])
        if isinstance(global_disabled, list):
            disabled.update(global_disabled)
    except Exception:
        pass
    return disabled


def _require_agent_privilege(request: Request, owner: str) -> None:
    """Homies ARE agents — users without can_use_agent can't create or run them."""
    auth_manager = getattr(request.app.state, "auth_manager", None)
    if not auth_manager:
        return
    try:
        privs = auth_manager.get_privileges(owner) or {}
    except Exception:
        return
    if not privs.get("can_use_agent", True):
        raise HTTPException(status_code=403, detail="Your account does not have agent privileges")


def _whitelist_disabled_tools(tool_whitelist: Optional[List[str]]) -> set:
    """tool_whitelist=None means 'all tools' (within the privilege ceiling)."""
    if not tool_whitelist:
        return set()
    try:
        from src.tool_index import BUILTIN_TOOL_DESCRIPTIONS
        all_tools = set(BUILTIN_TOOL_DESCRIPTIONS.keys())
    except Exception:
        return set()
    return all_tools - set(tool_whitelist)


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

def _resolve_owner_candidates(owner: str) -> List:
    """All (url, model, headers) the owner can use: configured fallback chain,
    then the default endpoint/model setting, then any enabled endpoint."""
    from src.endpoint_resolver import resolve_chat_fallback_candidates, resolve_endpoint_by_id
    candidates = list(resolve_chat_fallback_candidates(owner) or [])
    try:
        from src.settings import get_user_setting, load_settings
        settings = load_settings()
        ep_id = (get_user_setting("default_endpoint_id", owner or "", settings.get("default_endpoint_id", "")) or "").strip()
        model = (get_user_setting("default_model", owner or "", settings.get("default_model", "")) or "").strip()
        if ep_id:
            r = resolve_endpoint_by_id(ep_id, model or None, owner=owner)
            if r and r[1]:
                candidates.insert(0, r)
    except Exception:
        logger.exception("homies: default endpoint resolution failed")
    if not candidates:
        from core.database import ModelEndpoint
        from src.auth_helpers import owner_filter
        db = SessionLocal()
        try:
            q = db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True)  # noqa: E712
            q = owner_filter(q, ModelEndpoint, owner or None)
            for ep in q.all():
                models = []
                try:
                    models = json.loads(ep.cached_models or "[]")
                except (ValueError, TypeError):
                    models = []
                r = resolve_endpoint_by_id(ep.id, models[0] if models else None, owner=owner)
                if r and r[1]:
                    candidates.append(r)
                    break
        finally:
            db.close()
    return candidates


def setup_homies_routes(session_manager) -> APIRouter:
    router = APIRouter(prefix="/api/homies", tags=["homies"])

    def _owner(request: Request) -> str:
        owner = get_current_user(request)
        if not owner:
            raise HTTPException(status_code=401, detail="Not authenticated")
        return owner

    def _get_owned(db, homie_id: str, owner: str) -> HomieModel:
        homie = db.query(HomieModel).filter(
            HomieModel.id == homie_id,
            HomieModel.owner == owner,
        ).first()
        if not homie:
            raise HTTPException(status_code=404, detail="Homie not found")
        return homie

    # ------------------------------------------------------------------ #
    # CRUD
    # ------------------------------------------------------------------ #

    @router.get("")
    async def list_homies(request: Request):
        owner = _owner(request)
        db = SessionLocal()
        try:
            homies = (
                db.query(HomieModel)
                .filter(HomieModel.owner == owner)
                .order_by(HomieModel.created_at.asc())
                .all()
            )
            return {"homies": [_homie_to_dict(h) for h in homies]}
        finally:
            db.close()

    @router.post("")
    async def create_homie(request: Request, body: HomieCreate):
        owner = _owner(request)
        _require_agent_privilege(request, owner)
        homie_id = uuid.uuid4().hex
        homie = HomieModel(
            id=homie_id,
            owner=owner,
            name=_validate_name(body.name),
            avatar_path="",  # set by POST /{id}/avatar
            mouth_preset=_validate_mouth_preset(body.mouth_preset) if body.mouth_preset is not None else MOUTH_PRESETS[0],
            mouth_anchor=_validate_mouth_anchor(body.mouth_anchor) if body.mouth_anchor is not None else dict(DEFAULT_MOUTH_ANCHOR),
            mouth_color=_validate_mouth_color(body.mouth_color),
            voice_config=_validate_voice_config(body.voice_config) if body.voice_config is not None else dict(DEFAULT_VOICE_CONFIG),
            persona=_validate_persona(body.persona) if body.persona is not None else {},
            tool_whitelist=_validate_tool_whitelist(body.tool_whitelist),
            pinned=bool(body.pinned) if body.pinned is not None else False,
            canvas_pos=_validate_canvas_pos(body.canvas_pos) if body.canvas_pos is not None else dict(DEFAULT_CANVAS_POS),
            enabled=bool(body.enabled) if body.enabled is not None else True,
        )
        db = SessionLocal()
        try:
            db.add(homie)
            db.commit()
            db.refresh(homie)
            logger.info("Created homie %s (%r) for %s", homie_id, homie.name, owner)
            return _homie_to_dict(homie)
        finally:
            db.close()

    @router.patch("/{homie_id}")
    async def update_homie(request: Request, homie_id: str, body: HomieUpdate):
        owner = _owner(request)
        db = SessionLocal()
        try:
            homie = _get_owned(db, homie_id, owner)
            fields = body.dict(exclude_unset=True)
            if "name" in fields:
                homie.name = _validate_name(fields["name"])
            if "mouth_preset" in fields:
                homie.mouth_preset = _validate_mouth_preset(fields["mouth_preset"])
            if "mouth_anchor" in fields:
                homie.mouth_anchor = _validate_mouth_anchor(fields["mouth_anchor"])
            if "mouth_color" in fields:
                homie.mouth_color = _validate_mouth_color(fields["mouth_color"])
            if "voice_config" in fields:
                homie.voice_config = _validate_voice_config(fields["voice_config"])
            if "persona" in fields:
                homie.persona = _validate_persona(fields["persona"])
            if "tool_whitelist" in fields:
                homie.tool_whitelist = _validate_tool_whitelist(fields["tool_whitelist"])
            if "pinned" in fields:
                homie.pinned = bool(fields["pinned"])
            if "canvas_pos" in fields:
                homie.canvas_pos = _validate_canvas_pos(fields["canvas_pos"])
            if "enabled" in fields:
                homie.enabled = bool(fields["enabled"])
            db.commit()
            db.refresh(homie)
            return _homie_to_dict(homie)
        finally:
            db.close()

    @router.delete("/{homie_id}")
    async def delete_homie(request: Request, homie_id: str):
        owner = _owner(request)
        db = SessionLocal()
        try:
            homie = _get_owned(db, homie_id, owner)
            session_id = homie.session_id
            db.delete(homie)
            db.commit()
        finally:
            db.close()
        # Stop any in-flight run and drop the agent session (best-effort).
        if session_id:
            try:
                agent_runs.stop(session_id)
            except Exception:
                pass
            try:
                if session_manager:
                    session_manager.delete_session(session_id)
            except Exception:
                logger.exception("Could not delete session %s for homie %s", session_id, homie_id)
        # Remove avatar/voice files.
        paths = _avatar_paths(homie_id)
        try:
            if os.path.isdir(paths["dir"]):
                shutil.rmtree(paths["dir"])
        except OSError:
            logger.exception("Could not remove homie dir %s", paths["dir"])
        return {"deleted": homie_id}

    # ------------------------------------------------------------------ #
    # Avatar upload + serving
    # ------------------------------------------------------------------ #

    @router.post("/{homie_id}/avatar")
    async def upload_avatar(request: Request, homie_id: str, file: UploadFile = File(...)):
        owner = _owner(request)
        db = SessionLocal()
        try:
            homie = _get_owned(db, homie_id, owner)
            data = await read_upload_limited(file, HOMIE_UPLOAD_MAX_BYTES, "Homie avatar")
            processed = _process_avatar_png(data)
            paths = _avatar_paths(homie_id)
            os.makedirs(paths["dir"], exist_ok=True)
            # Atomic-ish write: tmp file then replace, per file.
            for key in ("full", "display"):
                tmp = paths[key] + f".tmp.{os.getpid()}"
                with open(tmp, "wb") as fh:
                    fh.write(processed[key])
                os.replace(tmp, paths[key])
            homie.avatar_path = paths["full"]
            db.commit()
            db.refresh(homie)
            logger.info(
                "Avatar for homie %s: %s in, full=%s display=%s",
                homie_id, format_byte_limit(len(data)) if len(data) % 1024 == 0 else f"{len(data)} bytes",
                len(processed["full"]), len(processed["display"]),
            )
            return _homie_to_dict(homie)
        finally:
            db.close()

    @router.get("/{homie_id}/avatar")
    async def get_avatar(request: Request, homie_id: str, size: str = "full"):
        owner = _owner(request)
        db = SessionLocal()
        try:
            _get_owned(db, homie_id, owner)
        finally:
            db.close()
        paths = _avatar_paths(homie_id)
        path = paths["display"] if size == "512" else paths["full"]
        if not os.path.isfile(path):
            raise HTTPException(status_code=404, detail="This homie has no avatar yet")
        return FileResponse(path, media_type="image/png")

    # ------------------------------------------------------------------ #
    # Talk to the homie — independent concurrent agent session
    # ------------------------------------------------------------------ #

    @router.post("/{homie_id}/message")
    async def message_homie(request: Request, homie_id: str, body: HomieMessage):
        owner = _owner(request)
        _require_agent_privilege(request, owner)
        text = (body.message or "").strip()
        if not text:
            raise HTTPException(status_code=422, detail="Message cannot be empty")

        db = SessionLocal()
        try:
            homie = _get_owned(db, homie_id, owner)
            if not homie.enabled:
                raise HTTPException(status_code=409, detail="This homie is disabled")
            homie_name = homie.name
            persona = dict(homie.persona or {})
            tool_whitelist = homie.tool_whitelist
            session_id = homie.session_id or f"homie-{homie_id}"
            needs_session_link = homie.session_id != session_id
        finally:
            db.close()

        if agent_runs.is_active(session_id):
            raise HTTPException(status_code=409, detail=f"{homie_name} is still working on the previous message")

        # Resolve the owner's model chain (homies have no model of their own —
        # they ride the user's default endpoint + fallbacks).
        candidates = _resolve_owner_candidates(owner)
        if not candidates:
            raise HTTPException(status_code=503, detail="No model endpoint configured — add one in Settings")
        endpoint_url, model, headers = candidates[0]
        fallbacks = candidates[1:]

        # Ensure the homie's own session exists (independent context/history).
        # Must happen BEFORE linking homie.session_id — the homies table has a
        # foreign key into sessions, so the session row must exist first.
        if session_manager:
            session_manager.ensure_task_session(
                session_id, f"Homie: {homie_name}", endpoint_url, model, owner=owner,
            )
        if needs_session_link:
            db = SessionLocal()
            try:
                homie = _get_owned(db, homie_id, owner)
                homie.session_id = session_id
                db.commit()
            except Exception:
                logger.exception("Could not link session %s to homie %s", session_id, homie_id)
            finally:
                db.close()

        # System prompt = compiled persona (name travels inside the persona dict).
        system_prompt = compile_homie_prompt({**persona, "name": homie_name})

        # Privilege ceiling first, then the per-homie whitelist on top.
        disabled_tools = _privilege_disabled_tools(request, owner)
        disabled_tools |= _whitelist_disabled_tools(tool_whitelist)

        # Replay this homie's own recent history for conversational continuity.
        messages: List[Dict[str, str]] = [{"role": "system", "content": system_prompt}]
        if session_manager:
            try:
                sess = session_manager.get_session(session_id)
                history = list(getattr(sess, "history", []) or [])[-HOMIE_HISTORY_MAX_MESSAGES:]
                for m in history:
                    role = getattr(m, "role", None)
                    content = getattr(m, "content", None)
                    if role in ("user", "assistant") and content:
                        messages.append({"role": role, "content": content})
            except Exception:
                logger.exception("Could not hydrate history for homie session %s", session_id)
        messages.append({"role": "user", "content": text})

        # Persist the user turn immediately.
        if session_manager:
            try:
                session_manager.add_message(session_id, ChatMessage("user", text))
            except Exception:
                logger.exception("Could not persist user message for homie session %s", session_id)

        from src.agent_loop import stream_agent_loop

        async def _run() -> Any:
            """Detached generator: stream the agent loop, persist the final
            assistant message on completion (mirrors chat's detached runs)."""
            collected: List[str] = []
            try:
                async for event_str in stream_agent_loop(
                    endpoint_url=endpoint_url,
                    model=model,
                    messages=messages,
                    headers=headers or {},
                    session_id=session_id,
                    owner=owner,
                    disabled_tools=disabled_tools,
                    fallbacks=fallbacks,
                ):
                    # Accumulate text deltas so the result survives with no subscriber.
                    if event_str.startswith("data: ") and not event_str.startswith("data: [DONE]"):
                        try:
                            payload = json.loads(event_str[6:].strip())
                            if isinstance(payload, dict) and isinstance(payload.get("delta"), str):
                                collected.append(payload["delta"])
                        except (ValueError, TypeError):
                            pass
                    yield event_str
            finally:
                final_text = "".join(collected).strip()
                if final_text and session_manager:
                    try:
                        from src.text_helpers import strip_think
                        cleaned = strip_think(final_text, prose=False) or final_text
                    except Exception:
                        cleaned = final_text
                    try:
                        session_manager.add_message(session_id, ChatMessage("assistant", cleaned))
                        session_manager.save_sessions()
                    except Exception:
                        logger.exception("Could not persist homie reply (session %s)", session_id)

        agent_runs.start(session_id, _run())
        if body.stream:
            return StreamingResponse(agent_runs.subscribe(session_id), media_type="text/event-stream")
        return {"session_id": session_id, "status": "working", "homie_id": homie_id}

    # ------------------------------------------------------------------ #
    # Persona suggestions — LLM-suggested motivations/frustrations/goals
    # ------------------------------------------------------------------ #

    @router.post("/persona-suggest")
    async def persona_suggest(request: Request, body: PersonaSuggest):
        owner = _owner(request)
        _require_agent_privilege(request, owner)
        field = (body.field or "").strip().lower()
        if field not in PERSONA_SUGGEST_FIELDS:
            raise HTTPException(status_code=422, detail=f"field must be one of {sorted(PERSONA_SUGGEST_FIELDS)}")
        candidates = _resolve_owner_candidates(owner)
        if not candidates:
            raise HTTPException(status_code=503, detail="No model endpoint configured — add one in Settings")
        persona = body.persona if isinstance(body.persona, dict) else {}
        name = " ".join(str(body.name or "").split()) or "the homie"
        existing = persona.get(field) or []
        if isinstance(existing, str):
            existing = [existing]
        context_bits = []
        for key in ("motivations", "frustrations", "goals"):
            vals = persona.get(key) or []
            if isinstance(vals, str):
                vals = [vals]
            if vals:
                context_bits.append(f"{key}: " + "; ".join(str(v) for v in vals[:6]))
        context = ("Existing persona — " + " | ".join(context_bits)) if context_bits else "The persona is otherwise blank."
        descriptions = {
            "motivations": "things that drive it — what it cares about and finds energizing",
            "frustrations": "things it pushes back on — pet peeves and dealbreakers",
            "goals": "standing objectives it pursues, ordered by priority",
        }
        messages = [
            {"role": "system", "content": (
                "You suggest persona traits for a user-created AI agent character. "
                "Reply with exactly 3 suggestions, one per line. No numbering, no bullets, "
                "no quotes, no commentary. Each suggestion is a short phrase under 12 words. "
                "Do not repeat anything the persona already has."
            )},
            {"role": "user", "content": (
                f"The agent is named {name}. {context}\n"
                f"Suggest 3 new {field} ({descriptions[field]}) for {name}."
            )},
        ]
        from src.llm_core import llm_call_async_with_fallback
        try:
            raw = await llm_call_async_with_fallback(candidates, messages, timeout=45)
        except HTTPException:
            raise
        except Exception as e:
            logger.warning("persona-suggest LLM call failed: %s", e)
            raise HTTPException(status_code=502, detail="Suggestion model unavailable — try again")
        try:
            from src.text_helpers import strip_think
            raw = strip_think(raw or "", prose=True) or raw
        except Exception:
            pass
        seen = {(" ".join(str(x).split())).lower() for x in existing}
        suggestions = []
        for line in (raw or "").splitlines():
            line = " ".join(line.split()).strip().strip("-•*\"'").strip()
            line = line.lstrip("0123456789.) ").strip()
            if line and line.lower() not in seen and len(line) <= 120:
                suggestions.append(line)
                seen.add(line.lower())
            if len(suggestions) >= 3:
                break
        if not suggestions:
            raise HTTPException(status_code=502, detail="No usable suggestions returned — try again")
        return {"field": field, "suggestions": suggestions}

    # ------------------------------------------------------------------ #
    # Status — drives the dock/canvas status dots
    # ------------------------------------------------------------------ #

    @router.get("/{homie_id}/status")
    async def homie_status(request: Request, homie_id: str):
        owner = _owner(request)
        db = SessionLocal()
        try:
            homie = _get_owned(db, homie_id, owner)
            session_id = homie.session_id
            enabled = bool(homie.enabled)
        finally:
            db.close()
        running = bool(session_id) and agent_runs.is_active(session_id)
        last_run = agent_runs.get_status(session_id) if session_id else None
        return {
            "homie_id": homie_id,
            "session_id": session_id,
            "enabled": enabled,
            "status": "working" if running else "idle",
            "last_run_status": last_run,  # running | done | error | stopped | None
        }

    return router
