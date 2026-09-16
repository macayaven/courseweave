/** Form choices come from the same versioned schema used by the server. */
import schema from "../../../../src/courseweave/contracts/courseweave.schema.json";
import type {
  AuthorPhase, AuthorExperience, AuthorTeacherStyle, AuthorTeacherPolicy,
  AuthorShareKind, AuthorProposalType, AuthorSurface, AuthorSurfacePurpose,
  AuthorNotebookSelector, AuthorRequirement,
} from "@courseweave/ui";

const definitions = schema.$defs;
export const progressModes = definitions.Phase.properties.progress.enum as AuthorPhase["progress"][];
export const accessModes = definitions.TeacherAccess.properties.mode.enum as AuthorTeacherPolicy["access"]["mode"][];
export const hintLevels = definitions.TeacherGuidance.properties.hint_level.enum as AuthorTeacherPolicy["guidance"]["hint_level"][];
export const shareKinds = definitions.CoursePolicies.properties.allowed_share_kinds.items.enum as AuthorShareKind[];
export const proposalTypes = definitions.CoursePolicies.properties.allowed_proposal_types.items.enum as AuthorProposalType[];
export const experienceTypes = Object.keys(definitions.Phase.properties.experience.discriminator.mapping) as AuthorExperience["type"][];
export const experiences = definitions.BuiltinExperience.properties.id.enum as Extract<AuthorExperience, { type: "builtin" }>["id"][];
export const styleTypes = Object.keys(definitions.TeacherGuidance.properties.style.discriminator.mapping) as AuthorTeacherStyle["type"][];
export const styles = definitions.BuiltinTeacherStyle.properties.id.enum as Extract<AuthorTeacherStyle, { type: "builtin" }>["id"][];
export const surfaceTypes = Object.keys(definitions.Phase.properties.surfaces.items.discriminator.mapping) as AuthorSurface["type"][];
export const surfacePurposes = definitions.HtmlSurface.properties.purpose.enum as AuthorSurfacePurpose[];
export const selectorTypes = Object.keys(definitions.NotebookSurface.properties.selector.discriminator.mapping) as AuthorNotebookSelector["type"][];
export const selectorMatches = definitions.CellTagsSelector.properties.match.enum as Extract<AuthorNotebookSelector, { type: "cell_tags" }>["match"][];
export const requirementTypes = Object.keys(definitions.Completion.properties.requirements.items.discriminator.mapping) as AuthorRequirement["type"][];
export const recordKinds = definitions.LearnerRecordRequirement.properties.record_kind.enum as Extract<AuthorRequirement, { type: "learner_record" }>["record_kind"][];
