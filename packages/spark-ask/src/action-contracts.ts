export interface SparkAskAutoAnswerRequest {
  title?: string;
  mode?: string;
  context?: string;
  flow?: string;
  questions: Array<{
    id: string;
    prompt: string;
    header?: string;
    type?: string;
    required?: boolean;
    defaultValues?: string[];
    options?: Array<{
      value: string;
      label: string;
      description?: string;
      preview?: string;
    }>;
  }>;
}
