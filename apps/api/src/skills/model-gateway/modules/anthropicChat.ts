/**
 * Anthropic Chat — Re-export from modules/modelGateway
 *
 * 实现已迁移至 modules/modelGateway/anthropicChat.ts，
 * 此文件保留为 re-export 以保持 skill 内部引用兼容。
 * 依赖方向：skills → modules (✓)
 */
export {
  anthropicChatWithSecretRotation,
  anthropicChatStreamWithSecretRotation,
  type AnthropicChatMessage,
} from "../../../modules/modelGateway/anthropicChat";
