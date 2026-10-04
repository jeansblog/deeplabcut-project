import json
import math
import os
import subprocess
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "projects" / "results"
SKELETON_CONNECTIONS = (
    (0, 1), (1, 2), (1, 3), (1, 4), (1, 5),
    (5, 6), (6, 7), (5, 8), (8, 9),
    (1, 10), (10, 11), (11, 12), (10, 13), (13, 14),
    (15, 16), (16, 1), (15, 17), (17, 18), (18, 16),
    (15, 19), (19, 21), (21, 20), (20, 22), (22, 23),
    (19, 37), (21, 37), (21, 38), (20, 38),
    (19, 24), (24, 25), (25, 26),
    (19, 27), (27, 28), (28, 29),
    (20, 31), (31, 33), (33, 30),
    (20, 32), (32, 34), (34, 35),
)


def _result_files_for_dir(target_dir: Path) -> list[dict]:
    files: list[dict] = []
    if not target_dir.exists():
        return files

    for item in sorted(target_dir.iterdir()):
        if item.is_file():
            files.append(
                {
                    "name": item.name,
                    "size": item.stat().st_size,
                    "path": str(item),
                    "extension": item.suffix.lower(),
                }
            )
    return files


def _make_video_browser_compatible(video_path: Path) -> None:
    converted_path = video_path.with_name(f"{video_path.stem}.h264.mp4")
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(video_path),
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                str(converted_path),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        os.replace(converted_path, video_path)
    except (OSError, subprocess.CalledProcessError) as exc:
        converted_path.unlink(missing_ok=True)
        detail = exc.stderr[-2000:] if isinstance(exc, subprocess.CalledProcessError) and exc.stderr else str(exc)
        raise RuntimeError(f"Could not convert labeled video to browser-compatible H.264: {detail}") from exc


def create_trajectory_video(
    video_path: str,
    coordinates_path: str,
    output_path: str,
    individual: int,
    bodyparts: list[int],
    confidence_threshold: float,
) -> None:
    """Write an MP4 of the original video with selected keypoint trails."""
    with Path(coordinates_path).open(encoding="utf-8") as coordinates_file:
        frames: Any = json.load(coordinates_file)
    if not isinstance(frames, list) or not frames:
        raise ValueError("Coordinate JSON must contain a non-empty frame list.")
    if not isinstance(frames[0], dict) or not isinstance(frames[0].get("bodyparts"), list):
        raise ValueError("Coordinate JSON has an invalid frame structure.")
    if individual >= len(frames[0]["bodyparts"]):
        raise ValueError("The selected individual does not exist in the coordinate data.")
    individual_points = frames[0]["bodyparts"][individual]
    if not isinstance(individual_points, list):
        raise ValueError("Coordinate JSON has an invalid keypoint list.")
    bodypart_count = len(individual_points)
    if any(bodypart >= bodypart_count for bodypart in bodyparts):
        raise ValueError("A selected keypoint does not exist in the coordinate data.")

    try:
        import cv2
    except ImportError as exc:
        raise RuntimeError("OpenCV is required to create a trajectory video.") from exc

    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        raise RuntimeError(f"Could not open source video: {video_path}")

    fps = float(capture.get(cv2.CAP_PROP_FPS))
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if fps <= 0 or width <= 0 or height <= 0:
        capture.release()
        raise RuntimeError("Source video has invalid frame rate or dimensions.")

    output = Path(output_path)
    raw_video = output.with_name(f"{output.stem}.rendering.mp4")
    muxed_video = output.with_name(f"{output.stem}.muxing.mp4")
    writer = cv2.VideoWriter(
        str(raw_video),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height),
    )
    if not writer.isOpened():
        capture.release()
        writer.release()
        raise RuntimeError("Could not initialize the trajectory video writer.")

    colors = [
        (0, 0, 255),
        (255, 0, 0),
        (0, 180, 0),
        (0, 200, 255),
        (255, 0, 200),
        (200, 200, 0),
        (255, 120, 0),
        (120, 0, 255),
    ]
    trail_layer = None
    previous_points: dict[int, tuple[int, int] | None] = {
        bodypart: None for bodypart in bodyparts
    }
    frame_index = 0
    try:
        while True:
            success, frame = capture.read()
            if not success:
                break
            if frame_index >= len(frames):
                raise ValueError("Source video has more frames than the coordinate JSON.")
            if trail_layer is None:
                trail_layer = frame.copy()
                trail_layer[:] = 0

            frame_data = frames[frame_index]
            if not isinstance(frame_data, dict) or not isinstance(frame_data.get("bodyparts"), list):
                raise ValueError(f"Coordinate data has an invalid structure at frame {frame_index}.")
            detections = frame_data["bodyparts"]
            if individual >= len(detections):
                raise ValueError(f"Coordinate data is missing individual {individual} at frame {frame_index}.")
            person_points = detections[individual]
            if not isinstance(person_points, list):
                raise ValueError(f"Coordinate data has an invalid keypoint list at frame {frame_index}.")
            current_points: list[tuple[tuple[int, int], tuple[int, int, int]]] = []
            for color_index, bodypart in enumerate(bodyparts):
                color = colors[color_index % len(colors)]
                point = person_points[bodypart] if bodypart < len(person_points) else None
                if point is None:
                    previous_points[bodypart] = None
                    continue
                if (
                    not isinstance(point, list)
                    or len(point) < 3
                    or not all(
                        isinstance(value, (int, float)) and math.isfinite(value)
                        for value in point[:3]
                    )
                ):
                    raise ValueError(
                        f"Coordinate data has an invalid keypoint at frame {frame_index}."
                    )
                if point[0] < 0 or point[1] < 0 or point[2] < confidence_threshold:
                    previous_points[bodypart] = None
                    continue

                x, y = int(round(point[0])), int(round(point[1]))
                if not (0 <= x < width and 0 <= y < height):
                    previous_points[bodypart] = None
                    continue

                previous = previous_points[bodypart]
                if previous is not None:
                    cv2.line(trail_layer, previous, (x, y), color, 2, cv2.LINE_AA)
                previous_points[bodypart] = (x, y)
                current_points.append(((x, y), color))

            if trail_layer is not None:
                trail_mask = cv2.cvtColor(trail_layer, cv2.COLOR_BGR2GRAY) > 0
                frame[trail_mask] = trail_layer[trail_mask]
            for position, color in current_points:
                cv2.circle(frame, position, 5, color, -1, cv2.LINE_AA)
            writer.write(frame)
            frame_index += 1

        if frame_index != len(frames):
            raise ValueError(
                f"Source video has {frame_index} frames but coordinate JSON has {len(frames)}."
            )
    except Exception:
        raw_video.unlink(missing_ok=True)
        raise
    finally:
        capture.release()
        writer.release()

    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(raw_video),
                "-i",
                video_path,
                "-map",
                "0:v:0",
                "-map",
                "1:a?",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-vf",
                "pad=ceil(iw/2)*2:ceil(ih/2)*2",
                "-c:a",
                "aac",
                "-shortest",
                "-movflags",
                "+faststart",
                str(muxed_video),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        os.replace(muxed_video, output)
    except (OSError, subprocess.CalledProcessError) as exc:
        muxed_video.unlink(missing_ok=True)
        detail = exc.stderr[-2000:] if isinstance(exc, subprocess.CalledProcessError) and exc.stderr else str(exc)
        raise RuntimeError(f"Could not encode trajectory video: {detail}") from exc
    finally:
        raw_video.unlink(missing_ok=True)


def create_skeleton_video(
    video_path: str,
    coordinates_path: str,
    output_path: str,
    individual: int,
    confidence_threshold: float,
    show_background: bool = True,
) -> None:
    """Write a video containing confident skeleton edges, optionally over the source."""
    with Path(coordinates_path).open(encoding="utf-8") as coordinates_file:
        frames: Any = json.load(coordinates_file)
    if not isinstance(frames, list) or not frames:
        raise ValueError("Coordinate JSON must contain a non-empty frame list.")
    if not isinstance(frames[0], dict) or not isinstance(frames[0].get("bodyparts"), list):
        raise ValueError("Coordinate JSON has an invalid frame structure.")
    if individual >= len(frames[0]["bodyparts"]):
        raise ValueError("The selected individual does not exist in the coordinate data.")

    try:
        import cv2
        import numpy as np
    except ImportError as exc:
        raise RuntimeError("OpenCV and NumPy are required to create a skeleton video.") from exc

    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        raise RuntimeError(f"Could not open source video: {video_path}")

    fps = float(capture.get(cv2.CAP_PROP_FPS))
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if fps <= 0 or width <= 0 or height <= 0:
        capture.release()
        raise RuntimeError("Source video has invalid frame rate or dimensions.")

    output = Path(output_path)
    raw_video = output.with_name(f"{output.stem}.rendering.mp4")
    writer = cv2.VideoWriter(
        str(raw_video),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height),
    )
    if not writer.isOpened():
        capture.release()
        writer.release()
        raise RuntimeError("Could not initialize the skeleton video writer.")

    frame_index = 0
    try:
        while True:
            success, source_frame = capture.read()
            if not success:
                break
            if frame_index >= len(frames):
                raise ValueError("Source video has more frames than the coordinate JSON.")

            frame_data = frames[frame_index]
            if not isinstance(frame_data, dict) or not isinstance(frame_data.get("bodyparts"), list):
                raise ValueError(f"Coordinate data has an invalid structure at frame {frame_index}.")
            detections = frame_data["bodyparts"]
            if individual >= len(detections):
                raise ValueError(f"Coordinate data is missing individual {individual} at frame {frame_index}.")
            person_points = detections[individual]
            if not isinstance(person_points, list):
                raise ValueError(f"Coordinate data has an invalid keypoint list at frame {frame_index}.")

            positions: dict[int, tuple[int, int]] = {}
            for bodypart, point in enumerate(person_points):
                if point is None:
                    continue
                if (
                    not isinstance(point, list)
                    or len(point) < 3
                    or not all(
                        isinstance(value, (int, float)) and math.isfinite(value)
                        for value in point[:3]
                    )
                ):
                    raise ValueError(f"Coordinate data has an invalid keypoint at frame {frame_index}.")
                x, y, confidence = point[:3]
                if x < 0 or y < 0 or confidence < confidence_threshold:
                    continue
                x, y = int(round(x)), int(round(y))
                if 0 <= x < width and 0 <= y < height:
                    positions[bodypart] = (x, y)

            canvas = source_frame if show_background else np.zeros_like(source_frame)
            for start, end in SKELETON_CONNECTIONS:
                if start in positions and end in positions:
                    color = (0, 255, 255) if show_background else (255, 255, 255)
                    thickness = 2
                    if show_background:
                        cv2.line(canvas, positions[start], positions[end], (0, 0, 0), 4, cv2.LINE_AA)
                    cv2.line(canvas, positions[start], positions[end], color, thickness, cv2.LINE_AA)
            writer.write(canvas)
            frame_index += 1

        if frame_index != len(frames):
            raise ValueError(
                f"Source video has {frame_index} frames but coordinate JSON has {len(frames)}."
            )
    except Exception:
        raw_video.unlink(missing_ok=True)
        raise
    finally:
        capture.release()
        writer.release()

    try:
        _make_video_browser_compatible(raw_video)
        os.replace(raw_video, output)
    finally:
        raw_video.unlink(missing_ok=True)


def run_superanimal_inference(video_path: str, output_dir: str | None = None) -> dict:
    """Run a SuperAnimal pose estimation pass on the selected video."""
    if not video_path or not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    target_dir = Path(output_dir) if output_dir else DEFAULT_OUTPUT_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    videotype = Path(video_path).suffix.lower().lstrip(".") or "mp4"

    try:
        import deeplabcut
    except ImportError as exc:
        raise RuntimeError("DeepLabCut is not installed in this environment.") from exc

    try:
        deeplabcut.video_inference_superanimal(
            videos=[video_path],
            superanimal_name="superanimal_quadruped",
            model_name="hrnet_w32",
            detector_name="fasterrcnn_resnet50_fpn_v2",
            videotype=videotype,
            create_labeled_video=True,
            dest_folder=str(target_dir),
            plot_bboxes=True,
        )
    except Exception as exc:
        raise RuntimeError(f"SuperAnimal inference failed: {exc}") from exc

    labeled_video = next(
        (item for item in target_dir.iterdir() if item.is_file() and item.suffix.lower() == ".mp4" and "labeled" in item.name.lower()),
        None,
    )
    if labeled_video:
        _make_video_browser_compatible(labeled_video)

    files = _result_files_for_dir(target_dir)
    labeled_mp4 = next((f for f in files if f["extension"] == ".mp4" and "labeled" in f["name"].lower()), None)
    json_file = next((f for f in files if f["extension"] == ".json"), None)
    h5_file = next((f for f in files if f["extension"] == ".h5"), None)

    return {
        "status": "success",
        "video_path": video_path,
        "output_dir": str(target_dir),
        "superanimal_name": "superanimal_quadruped",
        "files": files,
        "labeled_video": labeled_mp4["name"] if labeled_mp4 else None,
        "json_file": json_file["name"] if json_file else None,
        "h5_file": h5_file["name"] if h5_file else None,
    }
