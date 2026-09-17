variable "project_id" {
  description = "The GCP project ID to provision Discovery Engine resources in"
  type        = string
}

variable "region" {
  description = "The default GCP region"
  type        = string
  default     = "asia-northeast3"
}

variable "location" {
  description = "The location for Discovery Engine Data Store (global, us, eu)"
  type        = string
  default     = "global"
}

variable "collection_id" {
  description = "The collection ID for Discovery Engine"
  type        = string
  default     = "default_collection"
}

variable "data_store_id" {
  description = "The ID of the Discovery Engine Data Store"
  type        = string
  default     = "knowledge-qna-ds"
}

variable "data_store_display_name" {
  description = "Display name for the Data Store"
  type        = string
  default     = "Knowledge QnA Data Store"
}

variable "search_engine_id" {
  description = "The ID of the Search Engine app"
  type        = string
  default     = "knowledge-qna-engine"
}

variable "search_engine_display_name" {
  description = "Display name for the Search Engine app"
  type        = string
  default     = "Knowledge QnA Search Engine"
}
