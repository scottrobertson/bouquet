// Query results are often read into plain tuples next to the SQL that makes
// them, which reads better than naming a type for each one.
#![allow(clippy::type_complexity)]

pub mod alt_name;
pub mod backup;
pub mod config;
pub mod db;
pub mod debounce;
pub mod epg_logo;
pub mod events;
pub mod guide;
pub mod js;
pub mod models;
pub mod output;
pub mod playlist;
pub mod pool;
pub mod probe;
pub mod quality;
pub mod routes;
pub mod scheduler;
pub mod smart_sort;
pub mod sources;
pub mod sync;
pub mod upload;
pub mod xtream;

#[cfg(test)]
pub mod test_support;
