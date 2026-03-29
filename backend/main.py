import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.middleware.request_size import LimitRequestSizeMiddleware
from app.routers import (
    files,
    ocr,
    auth,
    legend,
    export,
    mindmap,
    translation,
    favorites,
    questions,
    question_types,
    subjects,
    tags,
    flashcards,
    workroom,
    workspace,
)
from app.agent import router as agent_router
from app.glm_ocr import router as glm_ocr_router


_LOG_DIR = Path(__file__).resolve().parent / "app" / "logs"
_LOG_DIR.mkdir(parents=True, exist_ok=True)
_LOG_FILE = _LOG_DIR / "backend.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(_LOG_FILE, encoding="utf-8"),
    ],
)

app = FastAPI(title="Exam Paper Stitcher Backend")

settings = get_settings()

celery_process: Optional[subprocess.Popen] = None


def _build_celery_worker_command() -> list[str]:
    queue_names = [
        settings.celery_queue_preview,
        settings.celery_queue_glm_layout,
        settings.celery_queue_embed,
    ]
    joined_queues = ",".join(queue_names)
    return [
        sys.executable,
        "-m",
        "celery",
        "-A",
        "app.celery_app.celery_app",
        "worker",
        "--pool=solo",
        "-l",
        "info",
        "-Q",
        joined_queues,
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(
    LimitRequestSizeMiddleware,
    max_body_size=settings.max_request_bytes,
)


@app.get("/health")
async def health_check():
    return {"status": "ok"}


@app.on_event("startup")
async def start_celery_worker() -> None:
    """在后端启动时自动启动 Celery worker。

    注意：在使用 `uvicorn --reload` 时，热重载子进程也会触发该事件，
    可能会启动多个 worker，建议生产环境关闭 reload，并单独配置进程数。
    """

    global celery_process
    if celery_process is not None and celery_process.poll() is None:
        return

    cmd = _build_celery_worker_command()

    env = {**os.environ, "REDIS_URL": settings.redis_url}
    try:
        celery_process = subprocess.Popen(cmd, env=env)
        logging.getLogger(__name__).info("Started Celery worker with PID %s", celery_process.pid)
    except Exception:  # pragma: no cover - runtime failure
        logging.getLogger(__name__).exception("Failed to start Celery worker")


@app.on_event("shutdown")
async def stop_celery_worker() -> None:
    """在后端关闭时终止 Celery worker 进程。"""

    global celery_process
    if celery_process is None:
        return

    if celery_process.poll() is None:
        logging.getLogger(__name__).info("Terminating Celery worker PID %s", celery_process.pid)
        celery_process.terminate()
        try:
            celery_process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            logging.getLogger(__name__).warning(
                "Celery worker PID %s did not exit in time, killing", celery_process.pid
            )
            celery_process.kill()

    celery_process = None


app.include_router(files.router)
app.include_router(ocr.router)
app.include_router(auth.router)
app.include_router(legend.router)
app.include_router(agent_router.router)
app.include_router(export.router)
app.include_router(mindmap.router)
app.include_router(translation.router)
app.include_router(favorites.router)
app.include_router(questions.router)
app.include_router(question_types.router)
app.include_router(subjects.router)
app.include_router(tags.router)
app.include_router(glm_ocr_router)
app.include_router(flashcards.router)
app.include_router(workspace.router)
app.include_router(workroom.router)
