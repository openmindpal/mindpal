/**
 * VLM Prompt Templates for Scene Perception
 * 
 * These prompts instruct the Vision-Language Model to return
 * standardized JSON outputs for different analysis tasks.
 * Designed to work with GPT-4V, Claude Vision, Qwen-VL, etc.
 */

export const SCENE_ANALYSIS_PROMPT = `You are a scene analysis system for an embodied robot agent. Analyze this image and return ONLY a valid JSON object with the following structure:

{
  "objects": [
    {
      "name": "object_name",
      "category": "furniture|food|tool|container|appliance|clothing|decoration|structure|other",
      "position": {"x": 0.0, "y": 0.0, "z": 0.0} or null,
      "state": "state_description",
      "affordances": ["graspable", "openable", "pourable", "pushable", "sittable", "climbable", "cuttable"],
      "confidence": 0.95
    }
  ],
  "spatial_relations": [
    {"subject": "object_a", "relation": "on|in|near|above|below|behind|in_front_of|left_of|right_of|inside|attached_to", "object": "object_b"}
  ],
  "scene_type": "kitchen|living_room|bedroom|bathroom|office|outdoor|garage|hallway|other",
  "hazards": ["hot_surface", "sharp_edge", "wet_floor", "fragile_item", "heavy_object", "electrical"],
  "summary": "Brief natural language description of the scene and notable features."
}

Rules:
- List ALL visible objects, not just prominent ones
- Estimate positions relative to camera (meters, right-hand coordinate: x=right, y=up, z=forward)
- For affordances, list only physically possible actions
- Identify ALL potential hazards for a robot
- Be precise and factual; do not hallucinate objects not visible`;

export const IDENTIFY_PROMPT = `You are a scene analysis system. Find the object "{target}" in this image.

Return ONLY valid JSON:
{
  "found": true/false,
  "object": {"name": "...", "category": "...", "position": {...} or null, "state": "...", "affordances": [...], "confidence": 0.9} or null,
  "alternatives": [similar objects if target not found exactly],
  "description": "Where and how the object appears, or why it wasn't found"
}`;

export const SPATIAL_QUERY_PROMPT = `You are a spatial reasoning system. Answer this spatial question about the image:

Question: "{question}"

Return ONLY valid JSON:
{
  "answer": "Clear natural language answer",
  "relations": [{"subject": "...", "relation": "on|in|near|above|below|behind|in_front_of|left_of|right_of|inside|attached_to", "object": "..."}],
  "confidence": 0.9
}`;

export const STATE_QUERY_PROMPT = `You are an object state analyzer. Determine the current state of "{object}" in this image.

Return ONLY valid JSON:
{
  "object": "{object}",
  "state": "primary state description (e.g., open, closed, hot, empty, full, broken, clean, dirty)",
  "properties": {
    "temperature": "hot|warm|cold|ambient",
    "fullness": "empty|partial|full",
    "integrity": "intact|damaged|broken",
    "cleanliness": "clean|dirty|stained",
    "position_state": "upright|tilted|fallen|hanging"
  },
  "confidence": 0.9
}
Only include properties that are observable. Set unobservable ones to "unknown".`;

export const AFFORDANCE_PROMPT = `You are a robot manipulation advisor. Analyze what actions are physically possible on the object "{object}" visible in this image.

Return ONLY valid JSON:
{
  "object": "{object}",
  "graspable": true/false,
  "graspStrategy": "top|side|pinch|wrap|none",
  "movable": true/false,
  "operations": ["open", "close", "pour", "press", "rotate", "slide", "lift", "flip", "squeeze", "cut", "stir"],
  "constraints": ["too_heavy", "attached_to_wall", "hot_surface", "fragile", "slippery", "requires_two_hands"],
  "confidence": 0.9
}
Rules:
- Only list operations physically possible given the object's current state
- Consider the object's size, weight, material, and current position
- Constraints should warn about potential failure modes`;

/** Build prompt with context injection */
export function buildPrompt(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}
