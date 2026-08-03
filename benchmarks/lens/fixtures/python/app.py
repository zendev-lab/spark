from models import User, display_name


def greeting(user: User) -> str:
    return f"Hello, {display_name(user)}"
