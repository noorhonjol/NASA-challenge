"""Test configuration.

`DATABASE_URL` comes from the environment or from `backend/.env`; there is no
built-in fallback, so a missing value fails loudly with the app's own
"DATABASE_URL is not set" error instead of silently testing another database.
"""
