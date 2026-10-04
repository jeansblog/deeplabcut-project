import json
import shutil
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.inference import create_skeleton_video, create_trajectory_video, run_superanimal_inference

PROJECT_ROOT = Path(__file__).resolve().parent.parent
UPLOAD_DIR = PROJECT_ROOT / "projects" / "uploads"
RESULTS_DIR = PROJECT_ROOT / "projects" / "results"
MOTION_SETTINGS_PATH = PROJECT_ROOT / "projects" / "motion_settings.json"

JOBS: dict[str, dict[str, Any]] = {}
executor = ThreadPoolExecutor(max_workers=2)
motion_settings_lock = threading.Lock()

app = FastAPI(title="DeepLabCut SuperAnimal API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=PROJECT_ROOT / "app" / "static"), name="static")


class MotionSettings(BaseModel):
    fps: float | None = Field(default=None, gt=0)
    pixels_per_cm: float | None = Field(default=None, gt=0)


class TrajectoryVideoRequest(BaseModel):
    individual: int = Field(ge=0)
    bodyparts: list[int] = Field(min_length=1)
    confidence_threshold: float = Field(ge=0, le=1)


class SkeletonVideoRequest(BaseModel):
    individual: int = Field(ge=0)
    confidence_threshold: float = Field(ge=0, le=1)
    show_background: bool = True


def _motion_settings_data(settings: MotionSettings) -> dict[str, float | None]:
    return {"fps": settings.fps, "pixels_per_cm": settings.pixels_per_cm}


def process_job(job_id: str, video_path: str) -> None:
    JOBS[job_id]["status"] = "processing"
    try:
        result = run_superanimal_inference(video_path, output_dir=str(RESULTS_DIR / job_id))
        JOBS[job_id]["status"] = "completed"
        JOBS[job_id]["result"] = result
        JOBS[job_id]["result_files"] = [
            {
                "name": item["name"],
                "extension": item["extension"],
                "size": item["size"],
                "url": f"/api/results/{job_id}/files/{item['name']}",
            }
            for item in result.get("files", [])
        ]
        JOBS[job_id]["video_url"] = next(
            (item["url"] for item in JOBS[job_id]["result_files"] if item["extension"] == ".mp4" and "labeled" in item["name"].lower()),
            None,
        )
        JOBS[job_id]["json_url"] = next(
            (item["url"] for item in JOBS[job_id]["result_files"] if item["extension"] == ".json"),
            None,
        )
        JOBS[job_id]["h5_url"] = next(
            (item["url"] for item in JOBS[job_id]["result_files"] if item["extension"] == ".h5"),
            None,
        )
    except Exception as exc:
        JOBS[job_id]["status"] = "failed"
        JOBS[job_id]["error"] = str(exc)


@app.get("/")
async def read_index() -> FileResponse:
    return FileResponse(PROJECT_ROOT / "app" / "templates" / "index.html")


@app.get("/health")
def health_check() -> dict:
    return {"status": "ok"}


@app.get("/api/settings/motion")
def get_motion_settings() -> dict[str, float | None]:
    with motion_settings_lock:
        if not MOTION_SETTINGS_PATH.exists():
            return _motion_settings_data(MotionSettings())
        try:
            with MOTION_SETTINGS_PATH.open(encoding="utf-8") as settings_file:
                settings = MotionSettings(**json.load(settings_file))
        except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Could not read motion settings: {exc}",
            ) from exc
    return _motion_settings_data(settings)


@app.put("/api/settings/motion")
def save_motion_settings(settings: MotionSettings) -> dict[str, float | None]:
    with motion_settings_lock:
        temporary_path = MOTION_SETTINGS_PATH.with_suffix(".tmp")
        try:
            MOTION_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
            temporary_path.write_text(
                json.dumps(_motion_settings_data(settings), indent=2) + "\n",
                encoding="utf-8",
            )
            temporary_path.replace(MOTION_SETTINGS_PATH)
        except OSError as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Could not save motion settings: {exc}",
            ) from exc
    return _motion_settings_data(settings)


@app.get("/api/jobs")
def list_jobs() -> dict:
    return {"jobs": JOBS}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found")
    return JOBS[job_id]


@app.get("/api/results/{job_id}/files/{filename}")
def get_result_file(job_id: str, filename: str) -> FileResponse:
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found")
    result_dir = RESULTS_DIR / job_id
    file_path = result_dir / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(file_path)


@app.get("/api/results/{job_id}")
def get_result(job_id: str) -> dict:
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found")
    if JOBS[job_id].get("status") != "completed":
        raise HTTPException(status_code=400, detail="Job is not completed yet")
    return JOBS[job_id].get("result", {})


@app.post("/api/jobs/{job_id}/trajectory-video")
def create_job_trajectory_video(job_id: str, request: TrajectoryVideoRequest) -> dict[str, str | int]:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.get("status") != "completed":
        raise HTTPException(status_code=400, detail="Inference job is not completed yet")

    bodypart_indices = request.bodyparts
    if any(index < 0 for index in bodypart_indices):
        raise HTTPException(status_code=422, detail="Keypoint indices must be non-negative.")
    if len(set(bodypart_indices)) != len(bodypart_indices):
        raise HTTPException(status_code=422, detail="Each keypoint may only be selected once.")

    result_dir = RESULTS_DIR / job_id
    coordinate_file = next(
        (item for item in job.get("result_files", []) if item["extension"] == ".json"),
        None,
    )
    if coordinate_file is None:
        raise HTTPException(status_code=400, detail="Coordinate JSON is not available for this job.")

    video_path = Path(job["path"])
    coordinates_path = result_dir / coordinate_file["name"]
    if not video_path.is_file() or not coordinates_path.is_file():
        raise HTTPException(status_code=404, detail="Source video or coordinate JSON was not found.")

    try:
        output_path = result_dir / f"trajectory_{uuid.uuid4().hex}.mp4"
        create_trajectory_video(
            str(video_path),
            str(coordinates_path),
            str(output_path),
            request.individual,
            bodypart_indices,
            request.confidence_threshold,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    file_data = {
        "name": output_path.name,
        "extension": ".mp4",
        "size": output_path.stat().st_size,
        "url": f"/api/results/{job_id}/files/{output_path.name}",
    }
    job["result_files"].append(file_data)
    job["trajectory_video_url"] = file_data["url"]
    return file_data


@app.post("/api/jobs/{job_id}/skeleton-video")
def create_job_skeleton_video(job_id: str, request: SkeletonVideoRequest) -> dict[str, str | int]:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.get("status") != "completed":
        raise HTTPException(status_code=400, detail="Inference job is not completed yet")

    result_dir = RESULTS_DIR / job_id
    coordinate_file = next(
        (item for item in job.get("result_files", []) if item["extension"] == ".json"),
        None,
    )
    if coordinate_file is None:
        raise HTTPException(status_code=400, detail="Coordinate JSON is not available for this job.")

    video_path = Path(job["path"])
    coordinates_path = result_dir / coordinate_file["name"]
    if not video_path.is_file() or not coordinates_path.is_file():
        raise HTTPException(status_code=404, detail="Source video or coordinate JSON was not found.")

    try:
        output_path = result_dir / f"skeleton_{uuid.uuid4().hex}.mp4"
        create_skeleton_video(
            str(video_path),
            str(coordinates_path),
            str(output_path),
            request.individual,
            request.confidence_threshold,
            request.show_background,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    file_data = {
        "name": output_path.name,
        "extension": ".mp4",
        "size": output_path.stat().st_size,
        "url": f"/api/results/{job_id}/files/{output_path.name}",
    }
    job["result_files"].append(file_data)
    job["skeleton_video_url"] = file_data["url"]
    return file_data


async def _create_inference_job(file: UploadFile) -> dict:
    if not file.filename:
        raise HTTPException(status_code=400, detail="A video file is required.")

    if file.size is not None and file.size == 0:
        raise HTTPException(status_code=400, detail="Uploaded video is empty.")

    video_ext = Path(file.filename).suffix.lower()
    allowed = {".mp4", ".avi", ".mov", ".mkv", ".wmv"}
    if video_ext not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported video format: {video_ext}. Supported formats: {sorted(allowed)}",
        )

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    job_id = uuid.uuid4().hex
    safe_name = Path(file.filename).name
    save_path = UPLOAD_DIR / f"{job_id}_{safe_name}"

    with save_path.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    JOBS[job_id] = {
        "id": job_id,
        "filename": safe_name,
        "path": str(save_path),
        "status": "queued",
        "result": None,
        "error": None,
        "result_files": [],
        "video_url": None,
        "json_url": None,
        "h5_url": None,
    }

    executor.submit(process_job, job_id, str(save_path))

    return {
        "job_id": job_id,
        "status": "queued",
        "filename": safe_name,
        "path": str(save_path),
    }


@app.post("/api/inference")
async def run_inference(file: UploadFile = File(...)) -> dict:
    return await _create_inference_job(file)


@app.post("/inference")
async def run_inference_legacy(file: UploadFile = File(...)) -> dict:
    return await _create_inference_job(file)
