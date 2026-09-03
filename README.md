# attendance-scanner

2026 하반기 보수교육 직원용 출석 QR 스캐너 웹앱입니다. 빌드 도구 없이 동작하는 정적 웹사이트라 GitHub Pages에 바로 배포할 수 있습니다.

## 포함 기능

- iPhone Safari 및 Android Chrome 대응
- 후면 카메라 기반 QR 실시간 스캔 (`html5-qrcode` 2.3.8)
- 직원 PIN 입력 후 카메라를 한 번 시작하는 태블릿 고정형 연속 스캔
- 출석 완료/중복/오류 결과를 1.3초 표시한 뒤 자동으로 다음 스캔 대기
- 동일 출석ID 3초 재스캔 방지 및 다른 출석ID 즉시 인식
- 출석ID 직접 입력
- Google Apps Script Web App API JSONP 호출
- 출석 성공 시 현재 회차명, 이름, 지역, 센터, 출석시간 표시
- 중복 출석 및 API/카메라 오류 안내
- 모바일 화면 최적화

## 연속 스캔 사용 방법

1. 직원 PIN을 입력하고 **카메라 시작**을 한 번 누릅니다.
2. 첫 번째 교육생의 QR을 비추면 카메라를 멈추지 않고 출석을 등록합니다.
3. 완료, 중복 또는 오류 결과를 잠시 확인한 뒤 화면이 자동으로 **다음 교육생 QR을 스캔해주세요** 상태로 돌아갑니다.
4. 같은 QR이 계속 보일 때는 3초 동안 재전송하지 않습니다. 다른 출석ID는 바로 인식합니다.
5. 업무가 끝났을 때만 **카메라 중지**를 누릅니다. 카메라 실행 중에도 출석ID 직접 입력을 사용할 수 있습니다.

## API_URL 설정

1. `js/app.js` 파일 상단의 `API_URL` 상수를 엽니다.
2. Google Apps Script Web App 배포 URL(`/exec`)로 값을 변경합니다.

```js
const API_URL = "https://script.google.com/macros/s/발급받은_SCRIPT_ID/exec";
```

`API_URL`은 이 파일의 한 곳에서만 관리합니다. 변경 후 커밋하고 GitHub에 푸시하면 됩니다.

### JSONP API 계약

웹앱은 다음 query string으로 JSONP 요청을 보냅니다.

| 파라미터 | 설명 |
| --- | --- |
| `action` | `attendance` |
| `attendanceId` | QR 또는 직접 입력한 출석ID |
| `pin` | 직원 PIN |
| `callback` | JSONP 콜백 함수명 |

프론트엔드는 `sessionId`를 저장하거나 선택하지 않으며, 회차 관련 파라미터도 전송하지 않습니다. QR 출석과 교육생 직접 출석은 반드시 Apps Script 서버의 동일한 회차 처리 로직을 사용해야 합니다. 이 저장소에는 Apps Script 서버 원본이 포함되어 있지 않으므로, 아래 계약을 실제 Web App `doGet(e)`에 반영해야 합니다.

### Apps Script 회차 처리 계약

Apps Script `doGet(e)`는 **매 출석 요청마다** `출석제어` 시트에서 현재 `OPEN` 상태인 회차를 조회하고, 그 회차의 `sessionId`와 `sessionName`을 출석 처리에 적용해야 합니다.

- 요청에서 사용하는 입력값은 `action`, `attendanceId`, `pin`, `callback`입니다.
- 클라이언트에서 전달되는 `sessionId`나 회차 선택값은 없으며, 서버가 현재 `OPEN` 회차를 결정합니다.
- 중복 여부는 `sessionId + attendanceId` 조합으로 판단합니다.
- 같은 교육생이 같은 회차에서 다시 요청하면 `duplicate: true`를 반환합니다.
- 관리자가 새 회차를 `OPEN`으로 변경하면 다음 요청부터 새 `sessionId`에 기록합니다. 프론트엔드 수정, 재배포, 새로고침은 필요하지 않습니다.
- 성공 응답에는 현재 회차명 `sessionName`을 포함해야 합니다.

성공 응답의 예시는 다음과 같습니다.

```json
{
  "success": true,
  "sessionName": "1일차 오후",
  "name": "홍길동",
  "region": "서울",
  "center": "강남센터",
  "attendanceTime": "2026-09-01T09:30:00+09:00"
}
```

이미 출석한 경우에는 아래처럼 `duplicate` 또는 `alreadyAttended`를 `true`로 반환하면 화면에 중복 출석 안내가 표시됩니다.

```json
{
  "success": false,
  "duplicate": true,
  "message": "이미 출석 처리되었습니다."
}
```

Apps Script의 `doGet(e)`는 `e.parameter.callback`을 함수명으로 사용해 JavaScript 응답을 반환해야 합니다. 예시는 다음과 같습니다.

```js
function doGet(e) {
  const callback = e.parameter.callback;
  const result = {
    success: true,
    name: "홍길동",
    region: "서울",
    center: "강남센터",
    attendanceTime: new Date().toISOString()
  };

  const output = `${callback}(${JSON.stringify(result)})`;
  return ContentService
    .createTextOutput(output)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}
```

실제 Apps Script에서는 `출석제어` 시트의 현재 `OPEN` 회차를 매 요청마다 읽고, `attendanceId`와 `pin`을 검증한 뒤 `sessionId + attendanceId`로 중복을 판단해야 합니다. 현재 `OPEN` 회차가 없으면 명확한 오류 응답을 반환하세요. JSONP 특성상 PIN이 URL query string에 포함되므로 HTTPS를 사용하고 Apps Script 로그/프록시/분석 도구에 민감정보가 남지 않도록 운영 환경을 확인해야 합니다.

## GitHub Pages 활성화

1. 이 폴더의 파일을 `attendance-scanner`라는 GitHub 저장소의 기본 브랜치에 푸시합니다.
2. GitHub 저장소에서 **Settings → Pages**로 이동합니다.
3. **Build and deployment**의 Source를 **Deploy from a branch**로 선택합니다.
4. Branch를 `main`, 폴더를 `/ (root)`로 선택하고 **Save**를 누릅니다.
5. 잠시 후 `https://<사용자명>.github.io/attendance-scanner/`에서 접속합니다.

GitHub Pages는 HTTPS로 제공되므로 카메라 권한을 사용할 수 있습니다. 카메라가 동작하지 않으면 주소가 `https://`인지, 브라우저 사이트 설정에서 카메라 권한이 허용되어 있는지 확인하세요.

## 로컬 확인

카메라 API는 일반적으로 `file://` 주소에서 동작하지 않습니다. 이 폴더에서 간단한 정적 서버를 실행하세요.

```bash
python -m http.server 8080
```

그 다음 `http://localhost:8080`으로 접속합니다. 실제 휴대전화 카메라 테스트는 GitHub Pages의 HTTPS 주소에서 진행하는 것을 권장합니다.
