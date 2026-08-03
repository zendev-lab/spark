from dataclasses import dataclass


@dataclass(frozen=True)
class User:
    name: str
    nickname: str | None = None


def display_name(user: User) -> str:
    return user.name
