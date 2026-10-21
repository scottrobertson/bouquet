use anyhow::Result;
use bouquet::config::config;
use bouquet::db::Db;
use bouquet::routes::{AppState, router};
use tower_http::compression::CompressionLayer;

#[tokio::main]
async fn main() -> Result<()> {
    let cfg = config();
    let db = Db::open(&cfg.database_path)?;
    bouquet::scheduler::start(&db);
    let app = router(AppState::new(db)).layer(CompressionLayer::new());

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", cfg.port)).await?;
    // CI waits for this exact line before smoke testing the image.
    println!("Bouquet listening on http://localhost:{}", cfg.port);
    axum::serve(listener, app).await?;
    Ok(())
}
