
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
  "NO_REPLY", "Agent-to-agent announce step"
]; // common stop words to ignore


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
    const clean = (str: string) => str.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/);

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