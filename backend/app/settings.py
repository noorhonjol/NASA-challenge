from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = ".env"


class Settings(BaseSettings):
    """Configuration loaded from the environment or backend/.env."""

    database_url: str = ""

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @model_validator(mode="after")
    def _require_database_url(self) -> "Settings":
        if not self.database_url:
            raise RuntimeError(
                "DATABASE_URL is not set. Copy backend/.env.example to backend/.env "
                "or export DATABASE_URL."
            )
        if not self.database_url.startswith("postgresql"):
            raise RuntimeError(
                "DATABASE_URL must be a PostgreSQL URL, e.g. "
                "postgresql+psycopg://user:password@localhost:5432/lunar_planner"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
