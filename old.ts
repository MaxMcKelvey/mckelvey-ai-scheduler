import { Ollama } from "ollama";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { readdir, mkdir, readFile, writeFile, unlink } from "node:fs/promises";

async function createWorkDir() {
    // read the ./work directory
    const currentDir = await readdir(".");

    // if the ./work directory does not exist, create it
    if (!currentDir.includes("work")) {
        await mkdir("./work");
    }
}

async function readWorkDirTree() {
    const workDir = await readdir("./work", { recursive: true });
    // remove directories from the array
    const files = workDir.filter((item) => !item.includes("."));
    return files;
}

async function readWorkFile(fileName: string) {
    const file = await readFile("./work/" + fileName, "utf8");
    return file;
}

async function writeWorkFile(fileName: string, content: string) {
    await writeFile("./work/" + fileName, content);
}

async function deleteWorkFile(fileName: string) {
    await unlink("./work/" + fileName);
}

async function readTasks() {
    const tasks = await readWorkFile("tasks.json");
    return JSON.parse(tasks);
}

async function writeTasks(tasks: any) {
    await writeWorkFile("tasks.json", JSON.stringify(tasks, null, 2));
}

async function processTask(task: any) {
    // TODO: Implement the task processing logic
}


// Define schemas for structured outputs
const ScheduleSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  startTime: z.string(),
  endTime: z.string(),
  priority: z.enum(["low", "medium", "high"]),
  category: z.string().optional(),
});

const ScheduleResponseSchema = z.object({
  schedules: z.array(ScheduleSchema),
  summary: z.string(),
});

type ScheduleResponse = z.infer<typeof ScheduleResponseSchema>;

const ollama = new Ollama();

async function generateSchedule(prompt: string): Promise<ScheduleResponse> {
    const currentDate = new Date().toISOString();
    console.log(currentDate);

    const response = await ollama.chat({
        model: "gemma3:1b",
        messages: [
        {
            role: "system",
            content: `You are a helpful scheduling assistant. Generate a structured schedule based on the user's request. Timestamps must be in ISO format. The current datetime is ${currentDate}.`
        },
        {
            role: "user",
            content: prompt
        }
        ],
        format: zodToJsonSchema(ScheduleResponseSchema)
    });

  const parsedResponse = ScheduleResponseSchema.parse(JSON.parse(response.message.content));
  return parsedResponse;
}

// Example usage
async function main() {
    try {
        const schedule = await generateSchedule("Schedule a meeting with the team tomorrow at 2pm for 1 hour");
        console.log("Generated Schedule:", schedule);
    } catch (error) {
        console.error("Error generating schedule:", error);
    }
}

main();
