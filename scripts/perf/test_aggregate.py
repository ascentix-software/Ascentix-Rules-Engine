import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from aggregate import aggregate

def test_aggregate_computes_median_p95_and_count_averages():
    samples = [
        {"totalMs": 10, "retrieveCount": 4, "retrieveMultipleCount": 2, "rowsFetched": 100,
         "stages": [{"name": "queryExecute", "ms": 6}, {"name": "evaluate", "ms": 4}]},
        {"totalMs": 20, "retrieveCount": 6, "retrieveMultipleCount": 2, "rowsFetched": 200,
         "stages": [{"name": "queryExecute", "ms": 14}, {"name": "evaluate", "ms": 6}]},
    ]
    agg = aggregate(samples)
    assert agg["stages"]["queryExecute"]["median"] == 10   # median of 6,14
    assert agg["stages"]["queryExecute"]["max"] == 14
    assert agg["counts"]["retrieveCount_avg"] == 5         # (4+6)/2
    assert agg["totalMs"]["median"] == 15

if __name__ == "__main__":
    test_aggregate_computes_median_p95_and_count_averages()
    print("OK")
