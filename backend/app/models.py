"""Import every module's models so metadata (Alembic, tests) sees all tables."""

from app.modules.activity.models import ActivityLog
from app.modules.auth.models import AdminUser
from app.modules.bots.models import Bot
from app.modules.campaigns.models import Campaign, CampaignBot, Delivery
from app.modules.media.models import MediaAsset, MediaBotFile
from app.modules.sources.models import BotSource, BotSuppression
from app.modules.subscribers.models import Subscriber

__all__ = [
    "ActivityLog",
    "AdminUser",
    "Bot",
    "BotSource",
    "BotSuppression",
    "Campaign",
    "CampaignBot",
    "Delivery",
    "MediaAsset",
    "MediaBotFile",
    "Subscriber",
]
