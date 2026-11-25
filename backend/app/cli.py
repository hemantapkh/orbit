"""Operator CLI.  uv run python -m app.cli create-admin you@example.com"""

import argparse
import asyncio
import getpass

import app.models  # noqa: F401
from app.modules.auth.service import create_admin


def main() -> None:
    parser = argparse.ArgumentParser(prog="orbit")
    sub = parser.add_subparsers(dest="cmd", required=True)
    ca = sub.add_parser("create-admin", help="Create an operator account")
    ca.add_argument("email")
    ca.add_argument("--name", default="")
    args = parser.parse_args()

    if args.cmd == "create-admin":
        password = getpass.getpass("Password: ")
        if len(password) < 10:
            raise SystemExit("Use at least 10 characters.")
        user = asyncio.run(create_admin(args.email, password, args.name))
        print(f"Created operator {user.email}")


if __name__ == "__main__":
    main()
