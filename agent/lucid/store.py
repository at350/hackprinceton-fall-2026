"""LangGraph Store on SQLite. `langgraph.json` points the server at `create_store`."""

from contextlib import asynccontextmanager
from pathlib import Path

from langgraph.store.sqlite.aio import AsyncSqliteStore

from lucid.config import STORE_DB


@asynccontextmanager
async def create_store():
    Path(STORE_DB).parent.mkdir(parents=True, exist_ok=True)
    async with AsyncSqliteStore.from_conn_string(STORE_DB) as store:
        await store.setup()
        yield store
