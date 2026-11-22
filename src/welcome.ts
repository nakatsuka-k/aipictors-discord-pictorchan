import { sendMessage, userDisplayName, type FileData, type Member } from "./discord";
import { GROK_API_KEY, IMAGE_MODEL, RULES_CHANNEL_ID, WELCOME_CHANNEL_ID } from "./config";

const ASPECT_RATIO = process.env.WELCOME_IMAGE_ASPECT_RATIO ?? "16:9";
const RESOLUTION = process.env.WELCOME_IMAGE_RESOLUTION ?? "2k";

async function generateWelcomeImage(userName: string): Promise<FileData | null> {
  const safeUserName = userName.trim().slice(0, 40) || "new member";
  const prompt = [
    "masterpiece, best quality, ultra-detailed, beautiful anime illustration, cute bishoujo character design.",
    "Aipictors mascot-inspired welcome artwork: one adorable cheerful anime girl, official mascot mood, warm and friendly expression, looking at viewer, gentle smile, slightly excited pose, hand raised in a welcoming gesture.",
    "Long multicolored hair with orange, blue, and green tones, soft bangs, ahoge, vivid blue eyes, delicate face, soft blush, polished lineart.",
    "Stylish student uniform, cute ribbon, clean silhouette, tasteful idol-like charm, elegant and wholesome.",
    "Bright celebratory background with pastel balloons, confetti, flowers, sparkles, soft light, dreamy atmosphere, creative community vibe.",
    "Wide cinematic composition, high detail, vibrant but clean colors, beautifully shaded, visually rich, clearly readable central subject.",
    `Subtly personalize the scene for a newly joined member named "${safeUserName}" without relying on readable text inside the image.`,
    "No watermark, no logo, no UI, no border, no speech bubble, no extra fingers, no extra limbs, no deformed hands, no blurry eyes, no low detail, no creepy expression.",
  ].join(" ");

  try {
    const res = await fetch("https://api.x.ai/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROK_API_KEY}` },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, aspect_ratio: ASPECT_RATIO, resolution: RESOLUTION, response_format: "b64_json" }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      console.error(`[WELCOME] image API error ${res.status} ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const json = (await res.json()) as any;
    let buffer: Uint8Array | null = null;
    const inline = json?.data?.[0]?.b64_json ?? json?.image;
    if (inline) buffer = Uint8Array.from(Buffer.from(inline, "base64"));
    const url = json?.data?.[0]?.url ?? json?.url;
    if (!buffer && url) {
      const img = await fetch(url);
      if (img.ok) buffer = new Uint8Array(await img.arrayBuffer());
    }
    if (!buffer) return null;
    return {
      name: `welcome_${safeUserName.replace(/[^a-zA-Z0-9]/g, "_") || "member"}.jpg`,
      data: buffer,
      description: `Welcome artwork for ${safeUserName}`,
    };
  } catch (error) {
    console.error("[WELCOME] image generation error", error);
    return null;
  }
}

export async function welcomeMember(member: Member & { user: NonNullable<Member["user"]> }) {
  try {
    const userName = userDisplayName(member.user, member.nick);
    const content = `🎉 **Welcome to Aipictors!** 🎉\n\n<@${member.user.id}>さん、ご参加いただきありがとうございます！\nThank you for joining us, ${userName}!\n欢迎加入，${userName}！\nBenvenuto/a, ${userName}! / 환영합니다, ${userName}님!\n\n📜 <#${RULES_CHANNEL_ID}> ← まずはここ / Start here / 请先看这里 / Inizia da qui / 여기부터`;
    const image = await generateWelcomeImage(userName);
    await sendMessage(WELCOME_CHANNEL_ID, image ? { content, files: [image] } : content).catch(async (error: unknown) => {
      console.error("[WELCOME] send with image failed", error);
      await sendMessage(WELCOME_CHANNEL_ID, content);
    });
    console.log(`[WELCOME] welcomed ${member.user.id} image=${Boolean(image)}`);
  } catch (error) {
    console.error("[WELCOME] error", error);
  }
}
