"""External platform integrations. Telegram is the only one, and the only one planned.

Everything that speaks a platform's API, or knows its credentials, identifiers and error
codes, lives in that platform's package. Feature modules (bots, campaigns, ...) call
these packages and work with the plain results they return."""
