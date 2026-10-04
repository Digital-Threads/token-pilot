import os


class Beta:
    """doc"""

    @property
    def run(self):
        def nested():
            return 1
        return nested()

    @staticmethod
    def stat():
        pass


def top(a):
    x = """
def fake():
"""
    return x + os.sep
