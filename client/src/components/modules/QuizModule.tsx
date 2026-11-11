/**
 * 知识小测验（P2-21）：每城最多 5 题，题目全部来自档案事实字段；
 * 本地判分，不依赖大模型；解析与来源随答案展示。
 */
import { useEffect, useState } from 'react';
import type { Quiz } from '@citylens/shared/schema';
import { getQuiz } from '../../lib/api';
import { PendingTag } from '../ui/Tags';

export function QuizModule({ cityId, cityName }: { cityId: string; cityName: string }) {
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [failed, setFailed] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setQuiz(null);
    setFailed(false);
    setAnswers({});
    setSubmitted(false);
    void getQuiz(cityId, controller.signal)
      .then(setQuiz)
      .catch((error: unknown) => {
        if ((error as Error).name !== 'AbortError') setFailed(true);
      });
    return () => controller.abort();
  }, [cityId]);

  if (failed) {
    return (
      <div className="surface-card rounded-md p-8">
        <PendingTag label="测验未能生成" />
        <p className="mt-3 text-xs leading-relaxed text-[var(--text-secondary)]">
          该城尚未成卷，暂无法出题。
        </p>
      </div>
    );
  }

  if (!quiz) {
    return (
      <div className="surface-card h-48 animate-pulse rounded-md" aria-busy="true">
        <span className="sr-only">出题中</span>
      </div>
    );
  }

  if (quiz.questions.length === 0) {
    return (
      <div className="surface-card rounded-md p-8">
        <PendingTag label="此题卷暂缺" />
        <p className="mt-3 text-xs leading-relaxed text-[var(--text-secondary)]">
          可核验的事实字段不足 1 题，宁缺毋滥，不出档案之外的知识点。
        </p>
      </div>
    );
  }

  const answered = quiz.questions.filter((question) => answers[question.id]).length;
  const correct = submitted
    ? quiz.questions.filter((question) => answers[question.id] === question.answerId).length
    : 0;

  return (
    <div className="surface-card rounded-md p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] tracking-[0.16em] text-[var(--text-secondary)]">
          {cityName} · 随堂小测 · 共 {quiz.questions.length} 题
          {submitted ? ` · 得分 ${correct} / ${quiz.questions.length}` : ` · 已答 ${answered}`}
        </p>
        {submitted ? (
          <button
            type="button"
            className="ink-btn px-3 py-1.5 text-[10px]"
            onClick={() => {
              setAnswers({});
              setSubmitted(false);
            }}
          >
            重做一遍
          </button>
        ) : (
          <button
            type="button"
            className="ink-btn ink-btn--solid px-3 py-1.5 text-[10px]"
            disabled={answered < quiz.questions.length}
            onClick={() => setSubmitted(true)}
          >
            提交批改
          </button>
        )}
      </div>

      <ol className="mt-6 space-y-6">
        {quiz.questions.map((question, index) => {
          const picked = answers[question.id] ?? null;
          const isCorrect = submitted && picked === question.answerId;
          const isWrong = submitted && picked !== null && picked !== question.answerId;
          return (
            <li key={question.id} className="border-b pb-5 hairline last:border-b-0">
              <p className="font-serif text-sm leading-relaxed">
                {index + 1}. {question.prompt}
                {question.type === 'boolean' ? '（判断）' : ''}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {question.options.map((option) => {
                  const chosen = picked === option.id;
                  const revealCorrect = submitted && option.id === question.answerId;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      disabled={submitted}
                      onClick={() =>
                        setAnswers((current) => ({ ...current, [question.id]: option.id }))
                      }
                      className={`ink-btn px-3 py-1.5 text-[11px] ${
                        chosen ? 'ink-btn--solid' : ''
                      } ${revealCorrect ? '!border-emerald-600 !text-emerald-700' : ''} ${
                        isWrong && chosen ? '!border-red-700 !text-red-700' : ''
                      }`}
                      aria-pressed={chosen}
                    >
                      {option.text}
                    </button>
                  );
                })}
              </div>
              {submitted ? (
                <div className="mt-3 rounded-sm border border-dashed p-3 text-[11px] leading-relaxed hairline">
                  <p className={isCorrect ? 'text-emerald-700' : 'text-red-700'}>
                    {isCorrect ? '答对了' : picked === null ? '未作答' : '答错了'}
                    {picked === null ? `：正确答案是「${question.options.find((option) => option.id === question.answerId)?.text}」` : ''}
                  </p>
                  <p className="mt-1 text-[var(--text-secondary)]">{question.explanation}</p>
                  {question.sourceRefs.length > 0 ? (
                    <p className="mono mt-1 text-[9px] text-[var(--text-secondary)]">
                      来源：{question.sourceRefs.join('、')}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
