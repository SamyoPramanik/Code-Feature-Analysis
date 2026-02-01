require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// CONFIGURATION
const WATSONX_API_URL = "https://us-south.ml.cloud.ibm.com/ml/v1/text/generation?version=2023-05-29";
const IAM_TOKEN_URL = "https://iam.cloud.ibm.com/identity/token";

// 1. Helper to get IAM Token (Tokens expire every hour, so you generate one dynamically)
async function getAccessToken() {
    const params = new URLSearchParams();
    params.append('grant_type', 'urn:ibm:params:oauth:grant-type:apikey');
    params.append('apikey', process.env.IBM_CLOUD_API_KEY);

    const response = await axios.post(IAM_TOKEN_URL, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return response.data.access_token;
}

// 2. Helper to fetch file content from GitHub
// A. Parse GitHub URL to get owner and repo
function parseGithubUrl(url) {
    const parts = url.replace("https://github.com/", "").split("/");
    return { owner: parts[0], repo: parts[1] };
}

// B. Fetch Repository Structure (Recursive or flat)
// Note: We use the recursive tree API to get all files
async function fetchRepoStructure(owner, repo) {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`;
    try {
        const headers = { 'User-Agent': 'node.js' };
        if (process.env.GITHUB_TOKEN) {
            headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
        }

        const response = await axios.get(apiUrl, { headers });
        return response.data.tree;
    } catch (e) {
        // Fallback for 'master' branch if 'main' fails
        try {
            const masterUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/master?recursive=1`;
            const headers = { 'User-Agent': 'node.js' };
            if (process.env.GITHUB_TOKEN) {
                headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
            }

            const response = await axios.get(masterUrl, { headers });
            return response.data.tree;
        } catch (error) {
            console.error("Error fetching repo structure:", error.message);
            throw new Error("Could not fetch repository structure. Check URL or branch name.");
        }
    }
}


// C. Fetch Raw File Content
async function fetchFileContent(owner, repo, path) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`;
    try {
        const response = await axios.get(rawUrl);
        return response.data;
    } catch (e) {
        // Fallback to master
        try {
            const rawUrlMaster = `https://raw.githubusercontent.com/${owner}/${repo}/master/${path}`;
            const response = await axios.get(rawUrlMaster);
            return response.data;
        } catch (error) {
            return `// Error fetching ${path}: ${error.message}`;
        }
    }
}

// Helper to chunk files
function chunkCodebase(files, maxChars = 150000) {
    const chunks = [];
    let currentChunk = "";

    for (const file of files) {
        const fileContent = `// File: ${file.path}\n${file.content}\n\n`;

        // If file itself is larger than maxChars, we must split it
        if (fileContent.length > maxChars) {
            // First, flush any existing chunk
            if (currentChunk.length > 0) {
                chunks.push(currentChunk);
                currentChunk = "";
            }

            // Slice the large file into maxChars pieces
            let offset = 0;
            while (offset < fileContent.length) {
                const slice = fileContent.substring(offset, offset + maxChars);
                // For the next slices, add a header indicating continuation
                const header = offset > 0 ? `// File: ${file.path} (Continuation)\n` : "";

                if (header.length + slice.length > maxChars) {
                    chunks.push(slice);
                } else {
                    chunks.push(header + slice);
                }
                offset += maxChars;
            }
        }
        // Normal case: Check if adding this file exceeds chunk size
        else if (currentChunk.length + fileContent.length > maxChars) {
            chunks.push(currentChunk);
            currentChunk = fileContent;
        } else {
            currentChunk += fileContent;
        }
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}


async function fetchGithubCode(githubUrl) {
    const { owner, repo } = parseGithubUrl(githubUrl);
    console.log(`Fetching repo: ${owner}/${repo}`);

    const tree = await fetchRepoStructure(owner, repo);

    // Filter for relevant code files (js, ts, jsx, tsx, py, java, etc.)
    // REMOVED .slice(0, 10) to get ALL files
    const relevantFiles = tree
        .filter(item => item.type === 'blob' && item.path.match(/\.(js|jsx|ts|tsx|py|java|go|rs|md|json|html|css)$/i))
        .filter(item => !item.path.includes('package-lock') && !item.path.includes('yarn.lock'));

    console.log(`Found ${relevantFiles.length} relevant files.`);

    const fetchedFiles = [];

    for (const file of relevantFiles) {
        console.log(`Fetching file: ${file.path}`);
        const content = await fetchFileContent(owner, repo, file.path);

        // Truncate extremely large single files to avoid blowing up memory/token limits completely if one file is 10MB
        // But we want "full codebase" so we'll be generous, e.g. 100k chars
        const truncatedContent = typeof content === 'string' && content.length > 100000
            ? content.substring(0, 100000) + "\n...[Truncated]"
            : content;

        fetchedFiles.push({ path: file.path, content: truncatedContent });
    }

    return fetchedFiles;
}

// 3. The Agent Endpoint
app.post('/api/audit-features', async (req, res) => {
    try {
        const { github_url, tasks } = req.body; // tasks is your {task_id, task...}[]

        // A. Retrieve All Files
        const allFiles = await fetchGithubCode(github_url);
        // Use default 15000 chars (~3-4k tokens) to be safe with context window
        const codeChunks = chunkCodebase(allFiles);

        console.log(`Split codebase into ${codeChunks.length} chunks.`);

        const accessToken = await getAccessToken();

        // Initialize current results with the input tasks.
        // We will update this array iteratively.
        let currentResults = JSON.parse(JSON.stringify(tasks));

        // Loop through chunks
        for (let i = 0; i < codeChunks.length; i++) {
            const chunk = codeChunks[i];
            console.log(`Processing Chunk ${i + 1}/${codeChunks.length}...`);

            // B. Construct the Prompt
            // We instruct the model to act as a QA Engine and output ONLY JSON.
            // We pass the CURRENT STATUS of tasks so it knows what is already found.
            const promptInput = `
<|system|>
You are a Code Audit AI. You analyze codebases to verify feature implementation.
You are processing the codebase in CHUNKS.
Input: A snippet of code (Chunk ${i + 1} of ${codeChunks.length}) and a list of tasks with their CURRENT known status.
Output: A strict JSON array updating the status of the tasks based on **new evidence** found in this chunk.the response array will content this type of json object {task_id: "", task: "", status: "", evidence: ""}

Rules:
1. If a task is already "implemented", verify if it is really implemented. if not then update the status to "not_implemented" or "partially_implemented" and valid suggestion/evidence.
2. If a task is "not_implemented" or "partially_implemented" and you find code in this chunk that implements it, update the status to "implemented" or "partially_implemented" and valid suggestion/evidence.
3. If you find NO relevance to a task in this specific chunk, keep the Task Object exactly as it is in the input (pass-through).
4. Output MUST be valid JSON array of the tasks.

Codebase Chunk:
${chunk} 

Current Task Statuses:
${JSON.stringify(currentResults)}

<|user|>
Analyze this chunk against the tasks and return the updated JSON array.
<|assistant|>
`;

            // C. Call watsonx.ai
            const payload = {
                input: promptInput,
                parameters: {
                    decoding_method: "greedy",
                    max_new_tokens: 1500, // Increased to allow full JSON return
                    min_new_tokens: 1,
                    stop_sequences: [],
                    repetition_penalty: 1
                },
                model_id: "ibm/granite-3-8b-instruct", // or meta-llama/llama-3-70b-instruct
                project_id: process.env.IBM_WATSON_PROJECT_ID
            };

            const watsonResponse = await axios.post(WATSONX_API_URL, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            // D. Update Results
            const generatedText = watsonResponse.data.results[0].generated_text;

            try {
                let cleanText = generatedText.replace(/```json/g, '').replace(/```/g, '').trim();
                const firstBracket = cleanText.indexOf('[');
                const lastBracket = cleanText.lastIndexOf(']');

                if (firstBracket !== -1 && lastBracket !== -1) {
                    cleanText = cleanText.substring(firstBracket, lastBracket + 1);
                    const chunkResult = JSON.parse(cleanText);

                    // Update our main results
                    currentResults = chunkResult;
                } else {
                    console.warn(`Chunk ${i + 1}: Could not find JSON brackets in response.`);
                    console.warn("Raw Output Preview:", generatedText.substring(0, 200));
                }
            } catch (e) {
                console.error(`Chunk ${i + 1} JSON Parse Error:`, e.message);
                // On error, we keep currentResults as is and continue to next chunk
            }
        }

        console.log("--------------------------------------------------");
        console.log("Final Analysis Complete.");
        console.log("--------------------------------------------------");

        res.json(currentResults);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Global Error Handlers
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
    // Keep the process alive or exit gracefully
    // process.exit(1); 
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION:', reason);
});