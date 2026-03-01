/**
 * 텍스트 파일을 읽어 인코딩(UTF-8 또는 EUC-KR)을 자동으로 감지하여 디코딩합니다.
 * @param file 업로드된 File 객체
 * @returns 디코딩된 문자열 Promise
 */
export const readTextFileAuto = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      const buffer = e.target?.result;
      if (buffer instanceof ArrayBuffer) {
        try {
          // 1. 먼저 UTF-8로 디코딩을 시도합니다. { fatal: true } 옵션으로 인코딩 오류를 감지합니다.
          const decoder = new TextDecoder('utf-8', { fatal: true });
          const text = decoder.decode(buffer);
          resolve(text);
        } catch (err) {
          // 2. UTF-8 디코딩 실패 시 EUC-KR(한국어 윈도우 기본)로 다시 시도합니다.
          const decoder = new TextDecoder('euc-kr');
          const text = decoder.decode(buffer);
          resolve(text);
        }
      } else {
        reject(new Error("파일을 읽는 중 오류가 발생했습니다."));
      }
    };

    reader.onerror = (e) => reject(e);

    reader.readAsArrayBuffer(file);
  });
};