// Embedding-based novelty score using cosine similarity
// Optional: npm install @xenova/transformers (only needed for getNoveltyScoreEmbedding)
// It enabled text processing based on embeddings i.e. noveltyScore based on it,
// or string similarity based on embeddings instead of using Jaccard similarity on n-grams. 
// This can help better capture semantic similarity, even when there is little word overlap (e.g. due to paraphrasing).
// Note: the embedding-based approach is more computationally expensive, so it's not enabled by default.
// The cost is not negligible in the methods that consider not only the prompt, but also the history and/or full context.
// In the case of novelty scoring and groundness indeed, we compare the answer against the full context, and we need to 
// apply sliding window to deal with the difference in length. 

const TOKENS = [
  // Pronouns
  "i", "you", "he", "she", "it", "we", "they", "them", "their", "this", "that", "these", "those",
  "my", "your", "his", "her", "its", "our",
  // Articles
  "a", "an", "the",
  // Prepositions
  "in", "at", "of", "to", "with", "on", "for", "from", "by", "about", "as", "into",
  // Conjunctions
  "and", "but", "or", "nor", "so", "yet",
  // Auxiliary verbs (basic forms)
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did",
  // Common adverbs/determiners
  "all", "any", "some", "each", "more", "most", "other", "such", "just", "very", "also", "only", "even",
  // OpenClaw keywords
  "NO_REPLY"
]; // common stop words to ignore

const IGNORE_MESSAGE = [
    "Agent-to-agent announce step", "NO_REPLY"
]

// novelty: subagent output vs main agent context (ground)
// coverage: subagent prompt vs main agent prompt + history (no system priompt, as it is not passed to sub-agents)
// groundness: subagent prompt vs main agent context + history (no system priompt, as it is not passed to sub-agents) -- NOT RELEVAT


// calculates how much of the content of largeStr is present in smallStr, using n-grams (default 3-grams)
// Example: how much of the main agent context is passed to the sub-agent context (coverage)
export function calculateCoverage(smallStr: string, largeStr: string, n: number = 3): number {
    const getNGrams = (str: string, n: number): string[] => {
        const words = str.toLowerCase().split(/\s+/);
        const nGrams: string[] = [];
        for (let i = 0; i <= words.length - n; i++) {
            nGrams.push(words.slice(i, i + n).join(' '));
        }
        return nGrams;
    };

    //removing TOKENs from the n-grams to focus on meaningful content words
    const clean = (str: string) => str.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(token => !TOKENS.includes(token));

    const nGramsA = new Set(getNGrams(smallStr, n).map(clean).flat());
    const nGramsB = getNGrams(largeStr, n).map(clean).flat();

    if (nGramsB.length === 0) return 0;

    const matches = nGramsB.filter(gram => nGramsA.has(gram));
    
    // Returns the percentage of B's content found in A
    return matches.length / nGramsB.length;
}

// calculates how much of the content of A is present in B, using token matching and ignoring common stop words
// Example: how much of sub-agent context comes from the caller context (ground)
export function calculateGroundness(context: string, ground: string): number {
    const clean = (str: string) => str.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/);

    const tokensA = clean(context);
    const tokensB = new Set(clean(ground));

    const filteredTokensA = tokensA.filter(token => !TOKENS.includes(token));

    if (filteredTokensA.length === 0) return 0;

    // Count how many tokens in A exist in B
    const matches = filteredTokensA.filter(token => tokensB.has(token));

    // The score represents the percentage of A that is "sourced" from B
    return matches.length / filteredTokensA.length;
}


// similarity between contexts using Jaccard similarity on token sets, ignoring common stop words
// Example: similarity of context between two iterations of the same agent, or between multiple sub-agents working on the same task
export function getJaccardSimilarity(str1: string, str2: string): number {
    const clean = (str: string) => str.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(token => token !== '');

    // if [Subagent Task] is in the prompt, we start from there and ignore what we have before (normally date, [Subagent Context] You are running as a subagent ...])
    const subagentTaskIndex = str1.indexOf("[Subagent Task]:");
    if (subagentTaskIndex !== -1) {
        str1 = str1.slice(subagentTaskIndex + "[Subagent Task]:".length);
    }
    const subagentTaskIndex2 = str2.indexOf("[Subagent Task]:");
    if (subagentTaskIndex2 !== -1) {
        str2 = str2.slice(subagentTaskIndex2 + "[Subagent Task]:".length);
    }

    // if one of the two strings contains any of the IGNORE_MESSAGE, we return 0
    if (IGNORE_MESSAGE.some(msg => str1.includes(msg) || str2.includes(msg))) {
        return 0;
    }

    str1 = removeDate(str1);
    str2 = removeDate(str2);    

    const tokensA = clean(str1);
    const tokensB = clean(str2);

    const filteredTokensA = tokensA.filter(token => !TOKENS.includes(token));
    const filteredTokensB = tokensB.filter(token => !TOKENS.includes(token));

    const set1 = new Set(filteredTokensA);
    const set2 = new Set(filteredTokensB);
    
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return intersection.size / union.size;
}

// a simple heuristic to determine if an answer is novel compared to the ground, based on coverage and presence of certain keywords (yes/no/true/false) and length of the answer.
// This is a very basic implementation and can be improved with more sophisticated NLP techniques.
// Example: if the sub-agent answer is just a rephrasing of the main agent prompt with no new information, it should have a low novelty score. On the other hand, if the sub-agent answer contains new information that is not present in the main agent context, it should have a higher novelty score.
export function getNoveltyScore(answer: string, ground: string): number {
    // if anwer is moslty (1 match out of 5 words) yes/no/true/false, we can consider it as novel
    const SHORT_ANSWER_TOKENS = 3;
    const yesNo = ["yes", "no", "true", "false","correct", "incorrect", "right", "wrong"];
    if (yesNo.includes(answer.toLowerCase()) && answer.toLowerCase().split(/\s+/).filter(token => !TOKENS.includes(token)).length <= SHORT_ANSWER_TOKENS) {
        return 1;
    }
    const coverage = calculateCoverage(ground, answer,2);
    return 1.0 - coverage
}

function removeDate(str: string): string {
    // Remove date patterns like [Mon 2026-05-04 16:26 GMT+2]
    return str.replace(/\[\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} GMT[+-]\d{1,2}\]/g, '').trim();
}

// Returns a Promise<number> (async)
// Uses sliding window approach: chunks ground text and finds maximum similarity
// Novelty = 1 - max(similarity with any chunk)
export async function getNoveltyScoreEmbedding(
    answer: string, 
    ground: string, 
    chunkSize: number = 4000, 
    overlap: number = 100
): Promise<number> {
    const SHORT_ANSWER_TOKENS = 3;
    const yesNo = ["yes", "no", "true", "false","correct", "incorrect", "right", "wrong"];
    if (yesNo.includes(answer.toLowerCase()) && answer.toLowerCase().split(/\s+/).filter(token => !TOKENS.includes(token)).length <= SHORT_ANSWER_TOKENS) {
        return 1;
    }


    const embA = await getEmbeddings(answer);
    if (!embA) return 0;
    
    // Chunk the ground text with sliding window
    const chunks = chunkText(ground, chunkSize, overlap);
    
    // Compute embeddings for all chunks in parallel
    const chunkEmbeddings = await Promise.all(chunks.map(chunk => getEmbeddings(chunk)));
    
    // Find maximum similarity across all chunks
    let maxSimilarity = 0;
    for (const embChunk of chunkEmbeddings) {
        if (!embChunk) continue;
        const similarity = cosineSimilarity(embA, embChunk);
        maxSimilarity = Math.max(maxSimilarity, similarity);
    }
    
    // Novelty is 1 - max_similarity (clamped to [0,1])
    return Math.max(0, Math.min(1, 1 - maxSimilarity));
}

// Split text into chunks with sliding window
function chunkText(text: string, chunkSize: number = 400, overlap: number = 100): string[] {
    const words = text.split(/\s+/);
    const chunks: string[] = [];
    
    if (words.length <= chunkSize) {
        return [text];
    }
    
    const step = chunkSize - overlap;
    for (let i = 0; i < words.length; i += step) {
        const chunk = words.slice(i, i + chunkSize).join(' ');
        chunks.push(chunk);
        if (i + chunkSize >= words.length) break;
    }
    
    return chunks;
}

// Compute cosine similarity between two embedding vectors
function cosineSimilarity(embA: Float32Array, embB: Float32Array): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < embA.length; i++) {
        dot += embA[i] * embB[i];
        normA += embA[i] * embA[i];
        normB += embB[i] * embB[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}


let embedder: any = null;
async function getEmbeddings(text: string): Promise<Float32Array | null> {
    try {
        if (!embedder) {
            // Dynamic import - only loads @xenova/transformers if getNoveltyScoreEmbedding is called
            // @ts-ignore
            const { pipeline } = await import('@xenova/transformers');
            embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        }
        // Returns [1, N] shape, flatten to 1D
        const output = await embedder(text, { pooling: 'mean', normalize: true });
        return output.data;
    } catch (e) {
        // Library not installed or other error - return null
        return null;
    }
}
