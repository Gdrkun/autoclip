"""Bounded retry for transient Windows sharing violations during atomic replacement."""
import os
from time import sleep


def replace_with_retry(source, destination):
    delays = (.02, .05, .1, .2)
    for attempt in range(len(delays) + 1):
        try:
            os.replace(source, destination)
            return
        except PermissionError as error:
            if getattr(error, 'winerror', None) not in (5, 32, 33) or attempt == len(delays):
                raise
            sleep(delays[attempt])
