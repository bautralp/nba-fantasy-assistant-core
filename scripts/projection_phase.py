"""A genuine zero-game phase requires an observed future NBA season opener."""
from datetime import date
from regular_season import schedule_index


def before_regular_season(content,year,as_of,index_reader=schedule_index):
    index=index_reader(content,year,date(year,6,30))
    dates=[g['date'] for g in index.values() if g['excluded'] in (None,'unplayed')]
    return bool(dates) and as_of.isoformat()<min(dates)


def empty_regular_games(content,year,as_of):
    from parquet_io import read_parquet
    from refresh_stats import REQUIRED
    table=read_parquet(content)
    if not REQUIRED.issubset(table.column_names):raise ValueError('Preseason source schema unknown')
    for row in table.select(['season','season_type','game_date']).to_pylist():
        if int(row['season'])!=year:raise ValueError('Preseason source season mismatch')
        if row['season_type']==2 and row['game_date']<=as_of:raise ValueError('Regular observation conflicts with future season opener')
    return []
