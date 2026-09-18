output "project_id" {
  description = "GCP Project ID"
  value       = var.project_id
}

output "data_store_id" {
  description = "Discovery Engine Data Store ID"
  value       = google_discovery_engine_data_store.ds.data_store_id
}

output "search_engine_id" {
  description = "Discovery Engine Search Engine ID"
  value       = google_discovery_engine_search_engine.engine.engine_id
}

output "serving_config_id" {
  description = "Default serving config ID for search operations"
  value       = "default_search"
}

output "env_configuration_snippet" {
  description = "Environment variables snippet to paste into .env or shell"
  value       = <<-EOT
    export GOOGLE_AGENT_SEARCH_PROJECT_ID="${var.project_id}"
    export GOOGLE_AGENT_SEARCH_DATA_STORE_ID="${google_discovery_engine_data_store.ds.data_store_id}"
    export GOOGLE_AGENT_SEARCH_LOCATION="${var.location}"
    export GOOGLE_AGENT_SEARCH_SERVING_CONFIG_ID="default_search"
  EOT
}
