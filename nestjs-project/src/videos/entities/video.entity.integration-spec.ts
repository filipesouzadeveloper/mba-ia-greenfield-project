import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VIDEO_MAX_SIZE_BYTES } from '../videos.constants';
import { generateVideoSlug } from '../video-slug.util';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `video-chan-${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    return videoRepository.create({
      slug: generateVideoSlug(),
      channel_id: channelId,
      title: 'My video',
      original_filename: 'my-video.mp4',
      mime_type: 'video/mp4',
      size_bytes: 1024,
      ...overrides,
    });
  }

  it('should enforce unique slug constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, { slug: 'abcdefghijk' }));

    await expect(
      videoRepository.save(buildVideo(channel.id, { slug: 'abcdefghijk' })),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it('should persist status as draft when not provided', async () => {
    const channel = await createChannel();
    const { id } = await videoRepository.save(buildVideo(channel.id));

    const saved = await videoRepository.findOneByOrFail({ id });
    expect(saved.status).toBe(VideoStatus.DRAFT);
  });

  it('should reject a status outside the video_status enum', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        buildVideo(channel.id, { status: 'published' as VideoStatus }),
      ),
    ).rejects.toThrow(/invalid input value for enum video_status/);
  });

  it('should return size_bytes of 10 GiB as a number', async () => {
    const channel = await createChannel();
    const { id } = await videoRepository.save(
      buildVideo(channel.id, { size_bytes: VIDEO_MAX_SIZE_BYTES }),
    );

    const saved = await videoRepository.findOneByOrFail({ id });
    expect(saved.size_bytes).toBe(10737418240);
    expect(typeof saved.size_bytes).toBe('number');
  });

  it('should delete the videos of a channel when the channel is removed', async () => {
    const channel = await createChannel();
    const other = await createChannel();
    await videoRepository.save(buildVideo(channel.id));
    await videoRepository.save(buildVideo(other.id));

    await channelRepository.delete({ id: channel.id });

    expect(await videoRepository.countBy({ channel_id: channel.id })).toBe(0);
    expect(await videoRepository.countBy({ channel_id: other.id })).toBe(1);
  });
});
