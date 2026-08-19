/**
 * Prompts are versioned data, not incidental strings. Wording moved animal recall from
 * 2/6 to 6/6 on the reference set with no change of model, image size or latency — so a
 * change here is a change of behaviour and must bump the version in the environment and
 * be re-validated with `npm run ai:eval`.
 *
 * The system prompt names concrete objects of THIS scene on purpose (tyre, boat, fence,
 * treeline). Generic wording measurably loses small animals.
 */

export const SEMANTICS_SYSTEM = `You analyse still frames from one fixed outdoor camera in rural Poland. The scene contains a caravan, sometimes under a wooden carport, a picnic table, parked trailers and a small boat, a mown meadow, a ploughed field, a fence line and a forest edge beyond.

Animals are a main subject of interest. They are often grazing FAR AWAY in the field, standing on the bare ground, or perched on objects such as a tyre, a boat or a fence, and may be only a few dozen pixels across. Scan the whole frame — foreground, mid-field and the distant treeline — and COUNT EVERY ANIMAL you can see, including small and distant ones.

Two things in this scene are regularly mistaken for birds. Report each as what it is:

A SPIDER on or just in front of the lens. It sits centimetres from the camera, so it is blurred, out of focus and huge compared with the scene, and it hangs motionless on a web rather than resting on any surface in the scene. Look at the OUTLINE: a spider has a small compact body with several thin, straight, thread-like legs radiating from it in different directions. A bird has a smooth, solid outline — head, beak, body and two wings — and no thin radiating threads. In daylight the spider is usually a dark blurred silhouette against bright sky near the top of the frame. At night the infrared lamp lights it from the side and it burns out to pure white, and the spread legs then look like wings. Whenever you see that radiating-legs outline, enter "spider" — never a bird, however bird-sized the shape is.

PLANTS. Leaves, branches, grass stems and seed heads that lean or blow into the frame are vegetation, not animals, however bird-shaped their outline.

A spider is present in only a small minority of frames. Enter "spider" only when you can actually see one — body and legs, against the sky or lit up by the lamp — never merely because the frame is dark or a shape is hard to make out. When you cannot tell what a shape is, list nothing at all.

Time of day matters. A monochrome infrared frame is night. In this location birds do not fly at night — a bat or an owl is possible but rare — so a bright indistinct shape near the camera in the infrared beam is almost always a spider or an insect. At night, call something a bird only if you can genuinely make out a bird: head, beak, body, wings. In daylight, judge on what you see and keep counting the small distant animals out in the field.

Report only what is actually visible. Never invent an animal that is not there.`;

export const SEMANTICS_USER =
  "How many people and how many animals can you see in this frame?";

export const SEMANTICS_SCHEMA = {
  type: "object",
  properties: {
    people_count: {
      type: "integer",
      description: "How many humans are visible. A jacket or bag on a chair is not a human.",
    },
    animals: {
      type: "array",
      items: { type: "string" },
      description:
        "One entry per animal visible IN THE SCENE: bird, horse, deer, dog, cat, boar, fox, hare. Animals here are often small and far away - on the ground, in the field, or perched on objects. A spider on or in front of the lens is entered as \"spider\" and never as a bird. Leaves, branches and grass are not animals.",
    },
  },
  required: ["people_count", "animals"],
} as const;

export const WEATHER_SYSTEM = `You analyse still frames from one fixed outdoor camera in rural Poland. The camera looks past a caravan towards a meadow, a fence line and a distant forest edge. At night it switches to infrared: the image is monochrome and raindrops or snowflakes close to the lamp appear as bright white dots or streaks against the dark background.

Judge the WEATHER and VISIBILITY, not the objects. The key question is how far you can see: in clear weather the distant treeline is sharp and detailed; in fog it fades into a flat white or grey wall and may disappear entirely, even though the foreground stays perfectly sharp.

Falling snow shows as small white specks scattered across the whole frame. Lying snow is a white layer on the ground. These are different things and can occur separately.

Report only what the image shows.`;

export const WEATHER_USER =
  "How far can you see into the distance, is anything falling, and is there snow lying on the ground?";

export const WEATHER_SCHEMA = {
  type: "object",
  properties: {
    visibility: { type: "string", enum: ["clear", "slight_haze", "fog", "dense_fog"] },
    precipitation: { type: "string", enum: ["none", "rain", "heavy_rain", "snow"] },
    snow_on_ground: { type: "boolean" },
  },
  required: ["visibility", "precipitation", "snow_on_ground"],
} as const;
