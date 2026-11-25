"""Import every module's models so metadata (Alembic, tests) sees all tables."""

from app.modules.activity.models import ActivityLog
from app.modules.auth.models import AdminUser
from app.modules.bots.models import Bot
from app.modules.campaigns.models import Campaign, CampaignBot, Delivery, TestGroup
from app.modules.media.models import MediaAsset, MediaBotFile
from app.modules.orgs.models import Invite, Membership, Organization
from app.modules.sources.models import BotSource, BotSuppression

__all__ = [
    "ActivityLog",
    "AdminUser",
    "Bot",
    "BotSource",
    "BotSuppression",
    "Campaign",
    "CampaignBot",
    "Delivery",
    "Invite",
    "Membership",
    "Organization",
    "MediaAsset",
    "MediaBotFile",
    "TestGroup",
]
