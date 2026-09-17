# 1. Enable Discovery Engine API
resource "google_project_service" "discoveryengine" {
  project = var.project_id
  service = "discoveryengine.googleapis.com"

  disable_on_destroy = false
}

# 2. Create Discovery Engine Data Store
# Using GENERIC industry vertical with CONTENT_REQUIRED for structured documents
resource "google_discovery_engine_data_store" "ds" {
  project           = var.project_id
  location          = var.location
  data_store_id     = var.data_store_id
  display_name      = var.data_store_display_name
  industry_vertical = "GENERIC"
  content_config    = "CONTENT_REQUIRED"
  solution_types    = ["SOLUTION_TYPE_SEARCH"]

  depends_on = [google_project_service.discoveryengine]
}

# 3. Create Search Engine App connected to Data Store
resource "google_discovery_engine_search_engine" "engine" {
  project        = var.project_id
  location       = var.location
  collection_id  = var.collection_id
  engine_id      = var.search_engine_id
  display_name   = var.search_engine_display_name
  data_store_ids = [google_discovery_engine_data_store.ds.data_store_id]

  search_engine_config {
    search_tier     = "SEARCH_TIER_STANDARD"
    search_add_ons  = ["SEARCH_ADD_ON_LLM"]
  }

  common_config {
    company_name = "Knowledge QnA"
  }

  depends_on = [google_discovery_engine_data_store.ds]
}
