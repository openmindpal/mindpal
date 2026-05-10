/**
 * Scene Perception Types
 * 
 * Standardized output structures for scene analysis.
 * These types represent the universal vocabulary for describing
 * any physical environment - not tied to any specific task.
 */

/** A detected object in the scene */
export interface DetectedObject {
  /** Object name (e.g., "cup", "door", "stove") */
  name: string;
  /** Object category (furniture/food/tool/container/appliance/clothing/decoration) */
  category: string;
  /** Estimated position in 3D space (null if not determinable) */
  position: { x: number; y: number; z: number } | null;
  /** Bounding box in image coordinates (normalized 0-1) */
  bbox?: { x: number; y: number; width: number; height: number };
  /** Current state of the object */
  state: string;
  /** Actions possible on this object */
  affordances: string[];
  /** Detection confidence (0-1) */
  confidence: number;
}

/** A spatial relationship between objects */
export interface SpatialRelation {
  /** The subject object */
  subject: string;
  /** Spatial relation type */
  relation: 'on' | 'in' | 'near' | 'above' | 'below' | 'behind' | 'in_front_of' | 'left_of' | 'right_of' | 'inside' | 'attached_to';
  /** The reference object */
  object: string;
}

/** Complete scene analysis result */
export interface SceneAnalysis {
  /** All detected objects */
  objects: DetectedObject[];
  /** Spatial relationships between objects */
  spatial_relations: SpatialRelation[];
  /** Scene type classification */
  scene_type: string;
  /** Identified hazards or risks */
  hazards: string[];
  /** Natural language scene summary */
  summary: string;
}

/** Object identification result */
export interface IdentifyResult {
  found: boolean;
  object: DetectedObject | null;
  alternatives: DetectedObject[];
  description: string;
}

/** Spatial query result */
export interface SpatialQueryResult {
  answer: string;
  relations: SpatialRelation[];
  confidence: number;
}

/** Object state result */
export interface StateResult {
  object: string;
  state: string;
  properties: Record<string, string | number | boolean>;
  confidence: number;
}

/** Affordance analysis result */
export interface AffordanceResult {
  object: string;
  graspable: boolean;
  graspStrategy: 'top' | 'side' | 'pinch' | 'wrap' | 'none';
  movable: boolean;
  operations: string[];
  constraints: string[];
  confidence: number;
}

/** VLM configuration */
export interface VlmConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
}
