"""Compare source timestamps without stretching a named time window silently."""

def window_change(samples, source_time: int, value: float, seconds: int,
                  tolerance: int = 10) -> float | None:
    target = source_time - seconds
    for stamp, previous in reversed(samples):
        if stamp <= target:
            return value - previous if target - stamp <= tolerance else None
    return None
