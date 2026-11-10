import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-5">
      <div className="max-w-lg text-center">
        <p className="eyebrow">404 · PAGE NOT FOUND</p>
        <h1 className="mt-6 font-serif text-[56px] leading-tight tracking-[0.14em] md:text-[72px]">
          此处无卷
        </h1>
        <p className="mt-5 text-sm leading-[1.9] text-[var(--text-secondary)]">
          你翻到的这一页尚未收录。回到卷首，重新寻一座城。
        </p>
        <Link to="/" className="ink-btn ink-btn--solid mt-8">
          回到卷首
        </Link>
      </div>
    </div>
  );
}
