//! Server-sent events. Every tab keeps this open to follow job progress live
//! and reload its data when something moves, instead of polling on a timer.

use std::convert::Infallible;
use std::time::Duration;

use axum::Router;
use axum::http::{HeaderValue, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures::{Stream, StreamExt, stream};
use tokio_stream::wrappers::BroadcastStream;

use super::AppState;
use crate::events;

pub fn routes() -> Router<AppState> {
    Router::new().route("/events", get(handler))
}

async fn handler() -> Response {
    // Open with a comment so headers flush and the browser fires onopen
    // straight away, and set the reconnect delay.
    let hello = stream::iter([Ok::<_, Infallible>(Event::default().retry(Duration::from_secs(3)).comment("connected"))]);
    let changes = BroadcastStream::new(events::subscribe()).filter_map(|event| async move {
        // A lagged tab just missed some updates; the next one catches it up.
        let event = event.ok()?;
        Some(Ok(Event::default().data(serde_json::to_string(&event).ok()?)))
    });
    let stream: std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>> = Box::pin(hello.chain(changes));
    // The keepalive stops reverse proxies dropping the connection as idle.
    let mut res = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(20)).text("keepalive"))
        .into_response();
    // no-transform stops compression from buffering the stream.
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-transform"));
    res
}
