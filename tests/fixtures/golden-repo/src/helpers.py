"""Small helper module used by the golden fixture to demonstrate
multi-language onboarding for the tp-onboard agent."""


def normalize_email(email: str) -> str:
    return email.strip().lower()


def slugify(name: str) -> str:
    return name.strip().lower().replace(" ", "-")
