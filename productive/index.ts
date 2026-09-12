// Public surface of the Productive API layer.
export { BOARD_TASK_LIMIT } from './api.js'
export { createProductiveApi, type ProductiveApi } from './api'
export {
  ProductiveApiError,
  isAuthError,
  type ProductiveCredentials
} from './client'
export {
  bodyToMarkdown,
  categoryKeyFromId,
  isAttachmentDeleted,
  mapAttachment,
  mapComment,
  mapFolder,
  mapPerson,
  mapProductiveTask,
  mapProject,
  mapTaskList,
  mapWorkflowStatus,
  markdownToBody,
  taskUrl
} from './mapper'
export type {
  ProductiveAttachment,
  ProductiveComment,
  ProductiveCreateTaskArgs,
  ProductiveFolder,
  ProductiveListTasksArgs,
  ProductivePerson,
  ProductiveProject,
  ProductiveRecord,
  ProductiveStateCategory,
  ProductiveTask,
  ProductiveTaskList,
  ProductiveTaskStatusFilter,
  ProductiveTaskUpdate,
  ProductiveWorkflowStatus
} from './types'
