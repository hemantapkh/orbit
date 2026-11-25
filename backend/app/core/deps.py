from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.integrations.telegram.client import TelegramClient

SessionDep = Annotated[AsyncSession, Depends(get_session)]


def get_telegram(request: Request) -> TelegramClient:
    return request.app.state.telegram


TelegramDep = Annotated[TelegramClient, Depends(get_telegram)]
