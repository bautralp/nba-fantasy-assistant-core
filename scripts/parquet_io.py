"""Read a fully downloaded Parquet buffer without the Dataset scanner.

PyArrow 23.0.1's Dataset scanner can abort during interpreter teardown with
Python-backed BytesIO sources (Apache Arrow #34314). read_table(use_threads=False)
still uses that scanner and reproduced an abort with the full daily source.
ParquetFile.read bypasses Dataset and disables column threads as well. Keep the
same pinned version and validate process exits as well as values in CI.
"""
import io
import pyarrow.parquet as pq


def read_parquet(content):
    return pq.ParquetFile(io.BytesIO(content)).read(use_threads=False)
