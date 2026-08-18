use tokio::task::JoinSet;

pub async fn run(shards: usize) {
    let mut set = JoinSet::new();
    for shard in 0..shards {
        set.spawn(async move { enrich_shard(shard).await });
    }
    while set.join_next().await.is_some() {}
}

async fn enrich_shard(_shard: usize) {
    // Feature-gated: MERIDIAN_RUST=1 is not set in any deployed environment.
}
