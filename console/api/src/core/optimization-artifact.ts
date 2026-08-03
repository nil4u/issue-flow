// @ts-nocheck

import domain from "issue-flow/domain"

const {
  allOptimizationProposalsTerminal,
  deriveOptimizationProposalStates,
  optimizationSourceIssueNumber,
  parseOptimizationProposalMarker,
  buildOptimizationProposalMarker,
  validateOptimizationArtifact: validateDomainOptimizationArtifact,
} = domain

function artifactError(error) {
  error.status = 422
  error.code = "optimization_artifact_error"
  return error
}

function validateOptimizationArtifact(data) {
  try {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Optimization artifact must be an object")
    if (data.schemaVersion !== 1 || data.artifact !== "optimization") throw new Error('Optimization artifact must use schemaVersion 1 and artifact "optimization"')
    return validateDomainOptimizationArtifact(data)
  } catch (error) {
    throw artifactError(error)
  }
}

const parseProposalMarker = parseOptimizationProposalMarker
const proposalMarker = buildOptimizationProposalMarker

export {
  allOptimizationProposalsTerminal,
  deriveOptimizationProposalStates,
  optimizationSourceIssueNumber,
  parseProposalMarker,
  proposalMarker,
  validateOptimizationArtifact,
}
