use axum::{routing::post, Router};

pub fn router() -> Router {
    Router::new().route("/v1/events", post(accept))
}

async fn accept(body: axum::body::Bytes) -> http::StatusCode {
    match crate::schema::parse(&body) {
        Ok(env) => {
            crate::log::append(env).await;
            http::StatusCode::ACCEPTED
        }
        Err(_) => http::StatusCode::UNPROCESSABLE_ENTITY,
    }
}
