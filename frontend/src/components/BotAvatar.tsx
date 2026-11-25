import { useState } from "react";
import { cx } from "./ui";

// Same fixed order as the chart palette, keyed by bot id so a bot keeps its colour everywhere.
const COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
export const botColor = (id: number) => COLORS[(Math.max(1, id) - 1) % COLORS.length];

type AvatarBot = { id: number; display_name: string; username: string; avatar_version?: string | null };

/** The bot's Telegram photo, or its initial on the bot's colour. */
export function BotAvatar({ bot, size = 32, className }: { bot: AvatarBot; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const initial = (bot.display_name || bot.username || "?").trim().charAt(0).toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (bot.avatar_version && !broken) {
    return (
      <img
        src={`/api/bots/${bot.id}/avatar?v=${encodeURIComponent(bot.avatar_version)}`}
        alt=""
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className={cx("shrink-0 rounded-full bg-line object-cover", className)}
        style={style}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cx("grid shrink-0 place-items-center rounded-full font-semibold text-white", className)}
      style={{ ...style, background: botColor(bot.id) }}
    >
      {initial}
    </span>
  );
}
