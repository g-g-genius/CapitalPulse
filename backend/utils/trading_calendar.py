"""Exchange closures. Update each year after the exchange publishes its notice.

2026 source: https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml
Weekends remain closed even when they are government make-up working days.
"""
from datetime import date

HOLIDAY_RANGES = {
    2026: (("01-01", "01-03"), ("02-15", "02-23"), ("04-04", "04-06"),
           ("05-01", "05-05"), ("06-19", "06-21"), ("09-25", "09-27"),
           ("10-01", "10-07")),
}


def is_trading_day(day: date) -> bool:
    if day.weekday() >= 5:
        return False
    label = day.strftime("%m-%d")
    return not any(start <= label <= end for start, end in HOLIDAY_RANGES.get(day.year, ()))


def calendar_status(day: date) -> dict:
    return {"year": day.year, "verified": day.year in HOLIDAY_RANGES,
            "warning": None if day.year in HOLIDAY_RANGES else "该年度节假日日历尚未维护，暂按工作日判断"}
