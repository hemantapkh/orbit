import { FileText, Film } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { Media, MessageContent } from "../../lib/api";
import { renderTelegramHtml } from "./telegramHtml";

/** Approximates how the message lands in a Telegram chat. */
export function MessagePreview({
  message,
  media,
  botName,
}: {
  message: MessageContent;
  media: Media | null;
  botName?: string;
}) {
  const textRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.replaceChildren(renderTelegramHtml(message.text, message.parse_mode));
  }, [message.text, message.parse_mode]);

  const empty = !message.text.trim() && !media;
  return (
    <div className="rounded-lg bg-[#c9d6cf] p-4 sm:p-5" aria-label="Message preview">
      {botName && <p className="mb-3 text-center text-xs text-ink-soft">{botName}</p>}
      <div className="max-w-[340px]">
        <div className="overflow-hidden rounded-2xl rounded-bl-md bg-white shadow-sm">
          {media && <MediaBlock media={media} />}
          {empty ? (
            <p className="px-3.5 py-2.5 text-[15px] text-ink-faint">Your message appears here.</p>
          ) : (
            message.text && (
              <div
                ref={textRef}
                className="px-3.5 py-2.5 text-[15px] leading-snug break-words whitespace-pre-wrap [&_a]:text-[#2a7ab8] [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-[#2a7ab8] [&_blockquote]:pl-2 [&_code]:rounded [&_code]:bg-canvas [&_code]:px-1 [&_code]:font-mono [&_code]:text-[13px] [&_pre]:rounded [&_pre]:bg-canvas [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-[13px] [&_.tg-spoiler]:rounded [&_.tg-spoiler]:bg-ink-faint/40"
              />
            )
          )}
        </div>
        {message.buttons.length > 0 && (
          <div className="mt-1 space-y-1">
            {message.buttons.map((b, i) => (
              <div key={i} className="rounded-lg bg-white/55 px-3 py-2 text-center text-sm font-medium text-ink">
                {b.text || "Button"}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MediaBlock({ media }: { media: Media }) {
  const src = `/api/media/${media.id}/file`;
  if (media.kind === "photo" || media.kind === "animation") {
    return <img src={src} alt="" className="max-h-80 w-full object-cover" />;
  }
  return (
    <div className="flex items-center gap-3 border-b border-line px-3.5 py-3">
      <span className="grid size-10 place-items-center rounded-full bg-[#2a7ab8] text-white">
        {media.kind === "video" ? <Film size={18} /> : <FileText size={18} />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{media.filename}</span>
        <span className="block text-xs text-ink-faint">{(media.size_bytes / 1024 / 1024).toFixed(1)} MB</span>
      </span>
    </div>
  );
}
