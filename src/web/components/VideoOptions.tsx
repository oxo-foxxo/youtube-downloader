import type { Container, VideoInfo } from '../../shared/contracts.js';
import { formatBytes, formatDuration } from '../format.js';
import { Icon } from './Icon.js';

interface VideoOptionsProps {
  video: VideoInfo;
  height: number | undefined;
  container: Container;
  busy: boolean;
  onHeight: (height: number) => void;
  onContainer: (container: Container) => void;
  onDownload: () => void;
  onReset: () => void;
}

export function VideoOptions({
  video,
  height,
  container,
  busy,
  onHeight,
  onContainer,
  onDownload,
  onReset,
}: VideoOptionsProps) {
  const variant = video.variants.find((item) => item.height === height);
  const available = variant?.containers.some(
    (option) => option.container === container && option.available,
  );
  return (
    <div className="result">
      <div className="metadata">
        {video.thumbnailUrl && (
          <div className="thumbnail">
            <img src={video.thumbnailUrl} alt="" />
            <span>{formatDuration(video.durationSeconds)}</span>
          </div>
        )}
        <div>
          <span className="section-kicker">ГОТОВО К ЗАГРУЗКЕ</span>
          <h2>{video.title}</h2>
          {!video.thumbnailUrl && <p>{formatDuration(video.durationSeconds)}</p>}
        </div>
      </div>
      <div className="choices">
        <div className="quality-choice">
          <label htmlFor="quality">Разрешение</label>
          <select
            id="quality"
            value={height}
            disabled={busy}
            onChange={(event) => onHeight(Number(event.target.value))}
          >
            {video.variants.map((item) => (
              <option
                key={item.height}
                value={item.height}
                disabled={!item.containers.some((option) => option.available)}
              >
                {item.height}p{item.fps ? ` · ${item.fps} FPS` : ''}
              </option>
            ))}
          </select>
          {variant && (
            <div className="format-meta">
              {variant.estimatedSizeBytes && (
                <span>≈ {formatBytes(variant.estimatedSizeBytes)}</span>
              )}
              <span>Исходное качество</span>
            </div>
          )}
        </div>
        {variant && (
          <fieldset disabled={busy}>
            <legend>Формат файла</legend>
            <div className="container-grid">
              {variant.containers.map((option) => (
                <label
                  className={`container-option ${option.available ? '' : 'disabled'}`}
                  key={option.container}
                >
                  <input
                    type="radio"
                    name="container"
                    value={option.container}
                    checked={container === option.container}
                    disabled={!option.available}
                    onChange={() => onContainer(option.container)}
                  />
                  <strong>{option.container.toUpperCase()}</strong>
                  <small>{option.available ? 'Без перекодирования' : option.reason}</small>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
      <div className="actions">
        <button
          className="primary"
          type="button"
          onClick={onDownload}
          disabled={busy || !available}
        >
          <Icon name="download" />
          {busy ? 'Запускаем…' : 'Скачать'}
        </button>
        <button className="text-button" type="button" onClick={onReset} disabled={busy}>
          Другое видео
        </button>
      </div>
    </div>
  );
}
