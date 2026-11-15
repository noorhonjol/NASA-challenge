# CLAUDE.md

Lunar Landing Site Navigator (NASA Space Apps 2026): a FastAPI backend (`backend/`) and a React + Cesium frontend (`frontend/`).

- **Start here:** `docs/PROJECT_STATUS.md` covers what has been built, design decisions, what was verified live, open issues and machine setup. Update it when you finish a feature.
- `README.md` is the judges' page (pitch, features, how to run). The API manual and developer notes are in `docs/DEVELOPER.md`.
- Secrets (`backend/.env`) and terrain data (`backend/data/terrain/`, ~3.6 GB) are not in git.
- Run tests before claiming work is done:
  - backend: `.\.venv\Scripts\python.exe -m pytest` (from `backend/`)
  - frontend: `npm.cmd test`, `npx tsc -b` and `npm.cmd run lint` (from `frontend/`)
