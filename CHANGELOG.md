# Changelog

## [Unreleased]

### Added
- Enhanced PR review workflow with OpenAI-compatible API support
- Support for custom AI endpoints (Kimi, Fireworks, etc.)
- Automatic AI code review on pull requests

### Changed
- Updated workflow input parameter names for consistency:
  - `openai-api-key` → `api-key`
  - `custom-api-base-url` → `api-base-url` 
  - `custom-model` → `model`

### Removed
- CLA workflow due to configuration issues (legal requirements still maintained through repository documentation)

### Fixed
- Workflow configuration to properly support custom AI endpoints