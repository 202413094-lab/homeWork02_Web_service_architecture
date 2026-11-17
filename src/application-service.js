import { application } from 'express';
import { AppError, missing, forbidden, invalidState } from './errors.js';

// TODO-01~04: 업무 규칙과 트랜잭션을 직접 구현합니다. docs/API.md를 먼저 읽으세요.
// actor는 검증된 로그인 사용자입니다. repo의 저장 함수는 권한을 검사하지 않습니다.
// 상태 변경과 이력 저장은 함께 성공하거나 함께 실패해야 합니다.
// 승인 취소와 자동 승급은 신청 2건 + 이력 2건을 한 트랜잭션으로 처리합니다.
export function createApplicationService(repo) {
  return {
    apply(actor,eventId) {
      // TODO-01: 행사·학생 역할·중복 검사 → PENDING 저장 + APPLY 이력.
      // 취소·승인 취소 기록도 중복입니다. 반환: 신청 객체.
      const searchlecture = repo.event(eventId);
      if(searchlecture === undefined)
      {
        throw missing();
      }
      if(actor.role !== 'STUDENT')
      {
        throw forbidden();
      }
      const applicate = repo.existing(eventId, actor.id);
      if(applicate !== undefined)
      {
        throw new AppError(409, 'ALREADY_APPLIED', '이미 신청한 특강입니다.');
      }

      repo.db.exec('BEGIN');
      try
      {
        const newApplication = repo.insert(eventId, actor.id);
        repo.addHistory({applicationId: newApplication.id, actorId: actor.id, action: 'APPLY', fromStatus: null, toStatus:'PENDING'});
        repo.db.exec('COMMIT');
        return newApplication;
      }
      catch(error)
      {
        repo.db.exec('ROLLBACK');
        throw error;
      }
    },
    cancel(actor,applicationId) {
      // TODO-02: 본인의 PENDING만 CANCELLED로 변경 + CANCEL 이력.
      // 학생의 대기 취소는 승인 자리를 비우지 않으므로 자동 승급하지 않습니다.
      const oneSearch = repo.application(applicationId);
      if(oneSearch === undefined)
      {
        throw missing();
      }

      if(actor.role !== 'STUDENT' || actor.id !== oneSearch.userId)
      {
        throw forbidden();
      }

      if(oneSearch.status !== 'PENDING')
      {
        throw invalidState();
      }
      
      repo.db.exec('BEGIN');
      try
      {
        const statusSetting = repo.setStatus(applicationId, 'CANCELLED');
        repo.addHistory({applicationId: applicationId, actorId: actor.id, action: 'CANCEL', fromStatus: 'PENDING', toStatus: 'CANCELLED'});
        repo.db.exec('COMMIT');
        return statusSetting;
      }
      catch(error)
      {
        repo.db.exec('ROLLBACK');
        throw error;
      }
    },
    approve(actor,applicationId) {
      // TODO-03: 담당자·PENDING·정원 검사 → APPROVED + APPROVE 이력.
      // 직접 승인은 운영자가 선택합니다. FIFO는 승인 취소 때의 자동 승급에 적용합니다.
      const applicationSearch = repo.application(applicationId);
      if (applicationSearch === undefined)
      {
        throw missing();
      }
      const eventForApproval = repo.event(applicationSearch.eventId);
      if(actor.role !== 'MANAGER' || actor.id !== eventForApproval.managerId)
      {
        throw forbidden();
      }
      if(applicationSearch.status !== 'PENDING')
      {
        throw invalidState();
      }
      const personnel = repo.approvedCount(applicationSearch.eventId);
      if(personnel >= eventForApproval.capacity)
      {
        throw new AppError(409, 'CAPACITY_FULL', '특강 정원이 가득 찼습니다');
      }

      repo.db.exec('BEGIN');
      try
      {
        const approvedApplication = repo.setStatus(applicationId, 'APPROVED');
        repo.addHistory({applicationId: applicationId, actorId: actor.id, action: 'APPROVE', fromStatus: 'PENDING', toStatus: 'APPROVED'});
        repo.db.exec('COMMIT');
        return approvedApplication;
      }
      catch(error)
      {
        repo.db.exec('ROLLBACK');
        throw error;
      }
    },
    revoke(actor,applicationId,reason) {
      // TODO-04: 담당자·APPROVED 검사 → REVOKED + REVOKE 이력.
      // 같은 행사 PENDING 중 created_at ASC, id ASC 첫 1건을 자동 승인합니다.
      // AUTO_APPROVE 이력의 causeHistoryId는 이 요청의 REVOKE 이력 ID입니다.
      // 상태와 이력의 부분 저장을 막고, 거부·오류 시 전체를 되돌리세요.
      // 반환: {revoked: 신청 객체, promoted: 신청 객체 또는 null}.
      
      repo.db.exec('BEGIN');
      try
      {
        const checkauthority = repo.application(applicationId);
        if(checkauthority === undefined)
        {
          throw missing();
        }
        const RevokeEvent = repo.event(checkauthority.eventId);
        if(actor.role !== 'MANAGER' || actor.id !== RevokeEvent.managerId)
        {
          throw forbidden();
        }
        if(checkauthority.status !== 'APPROVED')
        {
          throw invalidState();
        }

        const revokeSetting = repo.setStatus(applicationId, 'REVOKED');
        const revokeHistoryId = repo.addHistory({
          applicationId: applicationId,
          actorId: actor.id,
          action: 'REVOKE',
          fromStatus: 'APPROVED',
          toStatus: 'REVOKED',
          reason: reason
        });

        const nextPendingApplication = repo.db.prepare(`
          SELECT id
          FROM applications
          WHERE event_id = ? AND status = 'PENDING'
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `).get(checkauthority.eventId);

        let promoted = null;
        if(nextPendingApplication !== undefined)
        {
          promoted = repo.setStatus(nextPendingApplication.id, 'APPROVED');
        
          repo.addHistory({
            applicationId: nextPendingApplication.id,
            actorId: actor.id,
            action: 'AUTO_APPROVE',
            fromStatus: 'PENDING',
            toStatus: 'APPROVED',
            causeHistoryId: revokeHistoryId
          });
        }

        repo.db.exec('COMMIT');
        return {revoked: revokeSetting, promoted: promoted};
      }
      catch (error)
      {
        repo.db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}
